import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  Address,
  createPublicClient,
  erc20Abi,
  http,
  isAddress,
  parseAbiItem,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V3_LOCKER_ABI, V3_POOL_ABI } from "@/lib/abis/v3";
import { arcTestnet } from "@/lib/chains";
import { ADDRESSES } from "@/lib/constants";
import { parseInlineMetadata } from "@/lib/metadata";

export const dynamic = "force-dynamic";

const TWITTER_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const TWITTER_ME_URL = "https://api.twitter.com/2/users/me";
const FEES_COLLECTED_EVT = parseAbiItem(
  "event FeesCollected(uint256 indexed positionId, uint256 pairedAmount, uint256 clankerAmount)",
);

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(arcTestnet.rpcUrls.default.http[0]),
});

interface StateData {
  token: string;
  slotIndex: number;
  recipient: string;
  verifier: string;
  createdAt: number;
}

function redirectBackWithError(origin: string, error: string) {
  const url = new URL(`${origin}/claim`);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const origin = req.nextUrl.origin;

  if (!code || !state) return redirectBackWithError(origin, "missing_params");

  const cookieName = `tw_state_${state}`;
  const stateCookie = req.cookies.get(cookieName)?.value;
  if (!stateCookie) return redirectBackWithError(origin, "invalid_state");

  let stateData: StateData;
  try {
    stateData = JSON.parse(stateCookie);
  } catch {
    return redirectBackWithError(origin, "bad_state");
  }

  const { token, slotIndex, recipient, verifier } = stateData;
  if (!isAddress(token) || !isAddress(recipient)) {
    return redirectBackWithError(origin, "invalid_addresses");
  }

  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const backendPk = process.env.ARCADE_BACKEND_PRIVATE_KEY as `0x${string}` | undefined;
  if (!clientId || !clientSecret || !backendPk) {
    return redirectBackWithError(origin, "server_misconfigured");
  }

  // 1) Exchange code for access_token (PKCE confidential client).
  const callbackUrl = `${origin}/api/twitter-callback`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenRes = await fetch(TWITTER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    return redirectBackWithError(origin, "token_exchange_failed");
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) return redirectBackWithError(origin, "no_access_token");

  // 2) Fetch the user's @handle.
  const meRes = await fetch(TWITTER_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!meRes.ok) return redirectBackWithError(origin, "me_failed");
  const meJson = (await meRes.json()) as { data?: { username?: string } };
  const oauthHandle = meJson.data?.username?.toLowerCase();
  if (!oauthHandle) return redirectBackWithError(origin, "no_handle");

  // 3) Look up the token's metadata to read slot attribution.
  let positionId = 0n;
  let pairedToken = ADDRESSES.usdc as Address;
  let clankerToken = token as Address;
  let pairedAmount = 0n;
  let clankerAmount = 0n;
  try {
    const tokenState = (await client.readContract({
      address: ADDRESSES.launchpad,
      abi: LAUNCHPAD_ABI,
      functionName: "getTokenState",
      args: [token as Address],
    })) as { metadataURI: string; v2Pair: Address };

    const metadata = parseInlineMetadata(tokenState.metadataURI ?? "");
    const expectedHandle = metadata?.slotTwitterHandles?.[slotIndex]?.toLowerCase();
    if (!expectedHandle) {
      return redirectBackWithError(origin, "slot_not_attributed");
    }
    if (expectedHandle !== oauthHandle) {
      return redirectBackWithError(origin, "handle_mismatch");
    }

    // Position id from the locker.
    positionId = (await client.readContract({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "positionIdByToken",
      args: [token as Address],
    })) as bigint;
    if (positionId === 0n) return redirectBackWithError(origin, "no_position");

    // Read the position's token0/token1 to know which side is paired.
    const pool = tokenState.v2Pair;
    const [t0, t1] = await Promise.all([
      client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "token0" }) as Promise<Address>,
      client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "token1" }) as Promise<Address>,
    ]);
    pairedToken = t0.toLowerCase() === token.toLowerCase() ? t1 : t0;

    // Read the slot's bps from the locker so we can compute its share.
    const recipients = (await client.readContract({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "getRecipients",
      args: [positionId],
    })) as readonly { bps: number }[];
    const slotBps = recipients[slotIndex]?.bps ?? 0;
    if (slotBps === 0) return redirectBackWithError(origin, "slot_bps_zero");

    // Sum FeesCollected events for this position. Conservative chunked scan.
    const latest = await client.getBlockNumber();
    const CHUNK = 1000n;
    const MAX_BACK = 200_000n;
    let walked = 0n;
    let end = latest;
    let totalPaired = 0n;
    let totalClanker = 0n;
    while (walked < MAX_BACK) {
      const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
      try {
        const logs = await client.getLogs({
          address: ADDRESSES.v3Locker,
          event: FEES_COLLECTED_EVT,
          args: { positionId },
          fromBlock: start,
          toBlock: end,
        });
        for (const log of logs) {
          totalPaired += log.args.pairedAmount as bigint;
          totalClanker += log.args.clankerAmount as bigint;
        }
      } catch {
        break;
      }
      if (start === 0n) break;
      walked += end - start + 1n;
      end = start - 1n;
    }
    // Slot's share, in the "Both" pref bucket (simplifying assumption for MVP).
    pairedAmount = (totalPaired * BigInt(slotBps)) / 10_000n;
    clankerAmount = (totalClanker * BigInt(slotBps)) / 10_000n;

    // Cap by what the escrow actually holds, to never sign an over-payment.
    const escrow = ADDRESSES.twitterEscrow;
    const [escrowPaired, escrowClanker] = await Promise.all([
      client.readContract({
        address: pairedToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [escrow],
      }) as Promise<bigint>,
      client.readContract({
        address: clankerToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [escrow],
      }) as Promise<bigint>,
    ]);
    if (pairedAmount > escrowPaired) pairedAmount = escrowPaired;
    if (clankerAmount > escrowClanker) clankerAmount = escrowClanker;
  } catch (err) {
    return redirectBackWithError(origin, "onchain_read_failed");
  }

  // 4) Sign EIP-712 Claim with the backend wallet.
  const account = privateKeyToAccount(backendPk);
  const nonce = `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60); // 30 min

  const signature = await account.signTypedData({
    domain: {
      name: "ArcadeTwitterEscrow",
      version: "1",
      chainId: arcTestnet.id,
      verifyingContract: ADDRESSES.twitterEscrow,
    },
    types: {
      Claim: [
        { name: "positionId", type: "uint256" },
        { name: "slotIndex", type: "uint256" },
        { name: "recipient", type: "address" },
        { name: "pairedToken", type: "address" },
        { name: "pairedAmount", type: "uint256" },
        { name: "clankerToken", type: "address" },
        { name: "clankerAmount", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "Claim",
    message: {
      positionId,
      slotIndex: BigInt(slotIndex),
      recipient: recipient as Address,
      pairedToken,
      pairedAmount,
      clankerToken,
      clankerAmount,
      deadline,
      nonce,
    },
  });

  // 5) Redirect to /claim with signature + amounts.
  const url = new URL(`${origin}/claim`);
  url.searchParams.set("token", token);
  url.searchParams.set("positionId", positionId.toString());
  url.searchParams.set("slotIndex", String(slotIndex));
  url.searchParams.set("recipient", recipient);
  url.searchParams.set("pairedToken", pairedToken);
  url.searchParams.set("pairedAmount", pairedAmount.toString());
  url.searchParams.set("clankerToken", clankerToken);
  url.searchParams.set("clankerAmount", clankerAmount.toString());
  url.searchParams.set("deadline", deadline.toString());
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("sig", signature);
  url.searchParams.set("handle", oauthHandle);

  const res = NextResponse.redirect(url.toString());
  res.cookies.delete(cookieName);
  return res;
}
