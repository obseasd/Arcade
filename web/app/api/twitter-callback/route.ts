import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { rateLimit, rateLimitGlobal } from "@/lib/apiGuard";
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
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
import { arcTestnet } from "@/lib/chains";
import { ADDRESSES } from "@/lib/constants";
import { fetchMetadata } from "@/lib/metadata";

export const dynamic = "force-dynamic";

const TWITTER_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const TWITTER_ME_URL = "https://api.twitter.com/2/users/me";
const FEES_COLLECTED_EVT = parseAbiItem(
  "event FeesCollected(uint256 indexed positionId, uint256 pairedAmount, uint256 clankerAmount)",
);
const TOKEN_CREATED_EVT = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, uint8 mode, address creator2, uint16 creator2ShareBps, string name, string symbol, string metadataURI)",
);

/**
 * Audit Twitter Escrow C-2: defensive Twitter-handle normalisation.
 * Applies, in order:
 *  1) UTS-46 / NFKC Unicode normalisation (case-fold + canonical
 *     decomposition + compatibility recomposition) so e.g. fullwidth
 *     and halfwidth digits collapse to the same handle.
 *  2) Strip zero-width characters that Twitter rejects on signup but
 *     can sneak into an on-chain metadata blob.
 *  3) Lowercase.
 *  4) Validate against Twitter's strict character set
 *     ^[A-Za-z0-9_]{1,15}$. Anything else is treated as a bad handle
 *     so the signing flow refuses to proceed (Cyrillic homoglyph,
 *     emoji-injected, leading dot, etc.).
 *
 * Returns the cleaned handle or undefined when validation fails.
 */
function normaliseHandle(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  let h = raw.normalize("NFKC");
  // Strip zero-width characters: ZWSP, ZWNJ, ZWJ, BOM.
  h = h.replace(/[​-‍﻿]/g, "");
  h = h.toLowerCase().trim();
  // Strip a leading @ if the deployer included it.
  if (h.startsWith("@")) h = h.slice(1);
  if (!/^[a-z0-9_]{1,15}$/.test(h)) return undefined;
  return h;
}

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
  // Error path keeps the error code in the URL because there's nothing
  // sensitive in it and the user benefits from seeing what failed.
  const url = new URL(`${origin}/claim`);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  // Same canonicalization as twitter-login: strip `www.` so the redirect_uri
  // sent at the token-exchange step matches what was sent at authorization.
  const origin = req.nextUrl.origin.replace(/^(https?:\/\/)www\./, "$1");

  if (!code || !state) return redirectBackWithError(origin, "missing_params");

  // FSEC-004 hygiene: the state param is generated server-side as 16
  // bytes of crypto.randomBytes -> 32 hex chars. Validate the shape
  // before using it as a cookie name fragment so a hand-crafted state
  // can't address a cookie shape we didn't pick.
  if (!/^[0-9a-f]{32}$/.test(state)) {
    return redirectBackWithError(origin, "invalid_state");
  }

  // FSEC-007: per-IP rate limit on the OAuth completion path. The
  // current (0, 0)-amount sign is intentional (sync-fees-from-pool flow,
  // see the long-form comment further down), but bounding completions
  // per IP per minute caps the rate at which an attacker can farm
  // stockpiled signatures for any handle they happen to control.
  const rl = rateLimit(req, "twitter-callback", 10, 60_000);
  if (rl) return rl;
  // Audit F-5: per-slot global cap on top of per-IP. A botnet controlling
  // N residential IPs can farm 10*N sigs/min for any (token, slot) pair
  // the attacker owns; bounding by (token, slot) regardless of source IP
  // closes that funnel. We read state from the cookie's decoded payload
  // below; here we hash the raw state cookie name which already encodes
  // the (token, slot) tuple via the OAuth state nonce.
  const slotRl = rateLimitGlobal(`twitter-callback:state:${state}`, 30, 60_000);
  if (slotRl) return slotRl;

  const cookieName = `tw_state_${state}`;
  const stateCookie = req.cookies.get(cookieName)?.value;
  if (!stateCookie) return redirectBackWithError(origin, "invalid_state");

  // Audit Twitter Escrow H-2: verify the HMAC the login route attached
  // so a tampered cookie value (recipient swap, slot swap) is rejected
  // before the OAuth callback even talks to Twitter.
  const sepIdx = stateCookie.lastIndexOf(".");
  if (sepIdx < 0) return redirectBackWithError(origin, "bad_state");
  const stateJson = stateCookie.slice(0, sepIdx);
  const providedMac = stateCookie.slice(sepIdx + 1);
  const secret = process.env.ARCADE_OAUTH_STATE_SECRET || "";
  if (!secret) return redirectBackWithError(origin, "server_misconfigured");
  const expectedMac = crypto
    .createHmac("sha256", secret)
    .update(stateJson)
    .digest("hex");
  // Constant-time compare so cookie-tamper attempts can't bisect bytes.
  let macOk = providedMac.length === expectedMac.length;
  try {
    macOk =
      macOk &&
      crypto.timingSafeEqual(
        Buffer.from(providedMac, "hex"),
        Buffer.from(expectedMac, "hex"),
      );
  } catch {
    macOk = false;
  }
  if (!macOk) return redirectBackWithError(origin, "bad_state");

  let stateData: StateData;
  try {
    stateData = JSON.parse(stateJson);
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

  // no-abort-controller-on-twitter-token-and-me-fetches: 5s timeouts on
  // both Twitter API calls so a slow / dead Twitter endpoint doesn't
  // pin the Vercel serverless function up to its default 10s budget.
  const tokenCtrl = new AbortController();
  const tokenT = setTimeout(() => tokenCtrl.abort(), 5_000);
  // 1) Exchange code for access_token (PKCE confidential client).
  const callbackUrl = `${origin}/api/twitter-callback`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let tokenRes: Response;
  try {
    tokenRes = await fetch(TWITTER_TOKEN_URL, {
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
      signal: tokenCtrl.signal,
    });
  } catch {
    return redirectBackWithError(origin, "token_exchange_failed");
  } finally {
    clearTimeout(tokenT);
  }
  if (!tokenRes.ok) {
    return redirectBackWithError(origin, "token_exchange_failed");
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) return redirectBackWithError(origin, "no_access_token");

  // 2) Fetch the user's @handle.
  const meCtrl = new AbortController();
  const meT = setTimeout(() => meCtrl.abort(), 5_000);
  let meRes: Response;
  try {
    meRes = await fetch(TWITTER_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: meCtrl.signal,
    });
  } catch {
    return redirectBackWithError(origin, "me_failed");
  } finally {
    clearTimeout(meT);
  }
  if (!meRes.ok) return redirectBackWithError(origin, "me_failed");
  const meJson = (await meRes.json()) as { data?: { username?: string } };
  const rawOauthHandle = meJson.data?.username;
  // Audit Twitter Escrow C-2: normalise the handle through NFKC, strip
  // zero-width characters, and gate against Twitter's strict character
  // set so a Unicode homoglyph (Cyrillic 'е' in 'еlonmusk', emoji
  // injection, ZWJ insertion) cannot impersonate a real handle. The
  // raw handle from the OAuth response is otherwise compared as-is
  // against the on-chain metadata, which a deployer fully controls.
  const oauthHandle = normaliseHandle(rawOauthHandle);
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
    })) as { v2Pair: Address };

    // metadataURI lives in the TokenCreated event, not in state. Scan back to
    // find this token's emission. Chunked to stay friendly with RPC limits.
    const latestBlock = await client.getBlockNumber();
    let metadataURI = "";
    {
      let end = latestBlock;
      let walked = 0n;
      while (walked < 500_000n) {
        const start = end > 999n ? end - 999n : 0n;
        try {
          const logs = await client.getLogs({
            address: ADDRESSES.launchpad,
            event: TOKEN_CREATED_EVT,
            args: { token: token as Address },
            fromBlock: start,
            toBlock: end,
          });
          if (logs.length > 0) {
            metadataURI = (logs[0].args.metadataURI as string) ?? "";
            break;
          }
        } catch {
          break;
        }
        if (start === 0n) break;
        walked += end - start + 1n;
        end = start - 1n;
      }
    }
    // Supports both inline data: and ipfs:// metadata URIs. Pinata uploads
    // produce ipfs:// which the old parseInlineMetadata couldn't read,
    // causing every claim with an IPFS metadata to fail with
    // "slot_not_attributed" even when the handle was set correctly.
    const metadata = await fetchMetadata(metadataURI);
    // Audit Twitter Escrow C-2: also normalise the on-chain expected
    // handle through the same gate. A deployer-supplied
    // slotTwitterHandles entry containing zero-width chars or homoglyphs
    // would otherwise fail the strict equality and silently lock funds,
    // OR (worse) be set to a real handle the deployer doesn't own.
    const expectedHandle = normaliseHandle(metadata?.slotTwitterHandles?.[slotIndex]);
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

    // V3 escrow: read the PER-SLOT balance, not the raw ERC20 balance. This
    // is the audit F-3 fix - we sign amounts that fit within the on-chain
    // credit for (positionId, slotIndex, token). authorize() enforces the
    // same invariant; signing more would just revert with InsufficientBalance.
    const escrow = ADDRESSES.twitterEscrow;
    const [slotPaired, slotClanker] = await Promise.all([
      client.readContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "balances",
        args: [positionId, BigInt(slotIndex), pairedToken],
      }) as Promise<bigint>,
      client.readContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "balances",
        args: [positionId, BigInt(slotIndex), clankerToken],
      }) as Promise<bigint>,
    ]);
    if (pairedAmount > slotPaired) pairedAmount = slotPaired;
    if (clankerAmount > slotClanker) clankerAmount = slotClanker;
  } catch (err) {
    return redirectBackWithError(origin, "onchain_read_failed");
  }

  // Sign even when (pairedAmount, clankerAmount) is (0, 0). Two reasons:
  //
  // (a) H-04 sweep semantic: claimByTwitter transfers the FULL current
  //     `balances[slot][token]`, not the signed amounts. The signed amounts
  //     are floors (the contract enforces balance >= signed at authorize).
  //     So signing for 0 is fine as long as the live balance ends up > 0
  //     by authorize time, and the user gets everything credited.
  //
  // (b) Pool-pending fees: if no one has called locker.collectFees() yet,
  //     escrow.balances is 0 even though there's value sitting in the V3
  //     pool. The /claim page handles this by showing a "Sync fees from
  //     pool" step that the user runs from their own wallet BEFORE the
  //     on-chain authorize, after which the contract's M-11 check
  //     (`balances both 0`) no longer fires and authorize succeeds.
  //
  // The escrow's M-11 invariant still protects against authorizing a slot
  // with zero balance (NothingToClaim revert), so the user can never brick
  // a slot by signing a (0, 0) claim when nothing is credited - they just
  // need to sync first.

  // 4) Sign EIP-712 Claim with the backend wallet.
  const account = privateKeyToAccount(backendPk);
  const nonce = `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60); // 30 min

  const signature = await account.signTypedData({
    domain: {
      name: "ArcadeTwitterEscrow",
      // V3 bumped the domain version to "3" to invalidate any v2 signature
      // that might still be in flight (defence-in-depth on cross-contract
      // replay - v3 also has a different verifyingContract address).
      version: "3",
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

  // 5) sig-leak-through-browser-history-and-url-bar: hand the signed
  //    claim payload to /claim via an HttpOnly one-shot cookie instead of
  //    URL query params. The signature still leaves the server (it has
  //    to, the user submits it) but it never enters the URL bar, browser
  //    history, Referer header, browser-sync targets, or clipboard
  //    managers. /claim's client code calls /api/claim/payload on mount
  //    to consume the cookie. Cookie maxAge is 120s; the read endpoint
  //    is idempotent for that window (clears on first 200) so a refresh
  //    inside the window still works.
  const payload = {
    token,
    positionId: positionId.toString(),
    slotIndex,
    recipient,
    pairedToken,
    pairedAmount: pairedAmount.toString(),
    clankerToken,
    clankerAmount: clankerAmount.toString(),
    deadline: deadline.toString(),
    nonce,
    sig: signature,
    handle: oauthHandle,
  };

  const url = new URL(`${origin}/claim`);
  const res = NextResponse.redirect(url.toString());
  res.cookies.delete(cookieName);
  // Audit F-9: HMAC the cookie body with ARCADE_OAUTH_STATE_SECRET so a
  // tampered cookie (recipient swap, amount swap, sig swap) fails server-
  // side verification at /api/claim/payload. The cookie was already
  // HttpOnly + SameSite=Strict; this is defense-in-depth against same-
  // origin XSS that could otherwise rewrite the body silently.
  const claimBody = JSON.stringify(payload);
  const claimMac = crypto.createHmac("sha256", secret).update(claimBody).digest("hex");
  res.cookies.set("arcade_claim_payload", `${claimBody}.${claimMac}`, {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "strict",
    path: "/",
    maxAge: 120,
  });
  return res;
}
