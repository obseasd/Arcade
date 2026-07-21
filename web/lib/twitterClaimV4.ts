import crypto from "crypto";
import { zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { arcTestnet } from "@/lib/chains";
import { ADDRESSES } from "@/lib/constants";
import { serverPublicClient } from "@/lib/serverRpc";
import { normaliseHandle } from "@/lib/twitterHandle";
import {
    TWITTER_ESCROW_V4_ABI,
    TWITTER_ESCROW_V4_CLAIM_TYPES,
    TWITTER_ESCROW_V4_DOMAIN_VERSION,
} from "@/lib/abis/twitterEscrowV4";
import { getLaunchByPool, getReplyLaunchByPool } from "@/lib/twitterLaunchPersistence";
import { reconcileReplySlot } from "@/lib/twitterReplyReconcile";

/**
 * V4-hook claim path. The V3 flow in twitter-callback (dual paired+clanker,
 * keyed by the v3Locker's positionIdByToken) does NOT work for V4-hook launches:
 * their escrow (ArcadeTwitterEscrowV4) is single-token, keyed by uint256(poolId),
 * with a 7-field Claim at domain version "4". This module builds a V4 claim
 * payload; the callback falls through to it when the token is a hook launch.
 *
 * Attribution binds to the NUMERIC Twitter user-id (recorded at launch in
 * twitter_launches.user_id / op_user_id), NOT the @handle -- handles rename and
 * recycle, so a handle-only gate would let a recycled handle claim someone else's
 * fees. The @handle is display + a fallback when no user-id was recorded.
 *  - slot 0 (launcher): user_id from the DB (getLaunchByPool); handle fallback via
 *    the subgraph HandleAttribution(poolId).
 *  - slot 1 (reply-target): op_user_id from the DB. Before signing we reconcile the
 *    slot so its escrow balance reflects the operator's accrued half (idempotent;
 *    the launcher's slot 0 is credited directly by the hook).
 *
 * SECURITY: identical gates to the V3 path apply upstream in the callback (state
 * HMAC, per-IP + per-slot rate limit, OAuth). Here we additionally: normalise
 * BOTH the attributed handle and the OAuth handle through the shared
 * normaliseHandle; sign for the current on-chain balance only (the escrow's
 * authorize re-checks amount <= balance and recipient == msg.sender on-chain).
 */

const HOOK_ABI = [
    {
        type: "function",
        name: "poolIdOf",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "bytes32" }],
    },
    {
        type: "function",
        name: "twitterEscrow",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
] as const;

export interface V4ClaimPayload {
    escrowVersion: "v4";
    token: string;
    positionId: string;
    slotIndex: number;
    recipient: string;
    escrowToken: string; // USDC (the V4 escrow is single-token)
    escrowAddress: string; // resolved from the hook (env-independent)
    amount: string;
    deadline: string;
    nonce: string;
    sig: string;
    handle: string;
}

export type V4ClaimResult =
    | { kind: "not-v4" }
    | { kind: "error"; error: string }
    | { kind: "ok"; payload: V4ClaimPayload };

// Server-side RPC with a fallback across endpoints (see serverRpc.ts). The
// arc.network RPC is rate-limited from Vercel; viem falls over to thirdweb.
const rpcClient = serverPublicClient;

/** Launcher handle for a V4 launch = subgraph HandleAttribution(id = poolId). */
async function handleFromSubgraph(poolIdHex: string): Promise<string | undefined> {
    const url = process.env.NEXT_PUBLIC_GOLDSKY_URL;
    if (!url) return undefined;
    try {
        const q = `{ handleAttribution(id: "${poolIdHex.toLowerCase()}") { handle } }`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: q }),
        });
        if (!res.ok) return undefined;
        const j = (await res.json()) as { data?: { handleAttribution?: { handle?: string } | null } };
        return j?.data?.handleAttribution?.handle ?? undefined;
    } catch {
        return undefined;
    }
}

export async function buildV4ClaimPayload(args: {
    token: Address;
    slotIndex: number;
    recipient: Address;
    oauthHandle: string;
    /** OAuth numeric Twitter user-id (from /users/me data.id). Canonical claim
     *  key — handles rename/recycle, ids do not. */
    oauthUserId?: string;
    backendPk: `0x${string}`;
}): Promise<V4ClaimResult> {
    const { token, slotIndex, recipient, oauthHandle, oauthUserId, backendPk } = args;
    const hook = ADDRESSES.arcadeHook as Address;
    const usdc = ADDRESSES.usdc as Address;
    if (!hook || hook === zeroAddress) {
        return { kind: "not-v4" };
    }
    // V4 only exposes slots 0 (launcher) and 1 (reply-target).
    if (slotIndex !== 0 && slotIndex !== 1) return { kind: "not-v4" };

    const client = rpcClient();

    // 1) Is this a V4-hook token? poolIdOf(token) != 0.
    let poolId: string;
    try {
        poolId = (await client.readContract({
            address: hook,
            abi: HOOK_ABI,
            functionName: "poolIdOf",
            args: [token],
        })) as string;
    } catch (e) {
        console.error("[v4claim] poolIdOf read failed (hook=" + hook + "):", e instanceof Error ? e.message : e);
        return { kind: "error", error: "v4_poolid_read_failed" };
    }
    if (!poolId || /^0x0*$/.test(poolId)) return { kind: "not-v4" };

    const positionId = BigInt(poolId);

    // Escrow from ADDRESSES (env + deployments.json fallback). We avoid an extra
    // on-chain hook.twitterEscrow() read here: the Arc testnet RPC is rate-limited
    // ("request limit reached") and every saved eth_call keeps the claim under it.
    const escrow = ADDRESSES.twitterEscrow as Address;
    if (!escrow || escrow === zeroAddress) return { kind: "error", error: "slot_not_attributed" };

    // 2) Attribution gate. CANONICAL key = the NUMERIC Twitter user-id recorded at
    //    launch (twitter_launches.user_id / op_user_id). A handle-only gate lets a
    //    RECYCLED handle claim someone else's fees and locks a RENAMED owner out of
    //    their own (handles rename/recycle; ids don't). We compare the OAuth
    //    user-id against the recorded id; the handle is kept only as a fallback for
    //    a pool with no recorded user-id (e.g. DB unavailable) so a legit claimant
    //    isn't hard-locked out.
    let expectedUserId: string | undefined;
    let expectedHandle: string | undefined;
    if (slotIndex === 0) {
        const row = await getLaunchByPool(poolId);
        expectedUserId = row?.userId;
        expectedHandle = row?.handle ?? (await handleFromSubgraph(poolId));
    } else {
        const row = await getReplyLaunchByPool(poolId);
        if (!row) return { kind: "error", error: "slot_not_attributed" };
        expectedUserId = row.opUserId;
        expectedHandle = row.opHandle;
    }

    if (expectedUserId) {
        // Authoritative: the OAuth numeric user-id MUST equal the recorded one.
        if (!oauthUserId || oauthUserId !== expectedUserId) {
            console.error("[v4claim] user-id mismatch: attributed=" + expectedUserId + " oauth=" + String(oauthUserId));
            return { kind: "error", error: "handle_mismatch" };
        }
    } else {
        // Fallback (no recorded user-id): compare the normalised handle.
        const expNorm = normaliseHandle(expectedHandle);
        if (!expNorm) {
            console.error("[v4claim] no attributed handle/user-id (poolId=" + poolId + ", slot=" + slotIndex + ")");
            return { kind: "error", error: "slot_not_attributed" };
        }
        if (expNorm !== oauthHandle) {
            console.error("[v4claim] handle mismatch (no user-id): attributed=" + expNorm + " oauth=" + oauthHandle);
            return { kind: "error", error: "handle_mismatch" };
        }
    }

    // 2.5) ONLY NOW (handle proven) fund slot 1 on-demand. Audit fix: running
    // this before the handle check let any OAuth completer trigger the
    // operator-funded transfer. reconcileReplySlot is idempotent + reserves its
    // DB cursor atomically, so a failure here is non-fatal (balance stays at
    // whatever was already credited; the user can retry).
    if (slotIndex === 1) {
        try {
            await reconcileReplySlot(poolId);
        } catch {
            /* non-fatal */
        }
    }

    // 3) Current on-chain slot balance (USDC).
    let amount: bigint;
    try {
        amount = (await client.readContract({
            address: escrow,
            abi: TWITTER_ESCROW_V4_ABI,
            functionName: "balances",
            args: [positionId, BigInt(slotIndex), usdc],
        })) as bigint;
    } catch (e) {
        console.error("[v4claim] escrow.balances read failed (escrow=" + escrow + "):", e instanceof Error ? e.message : e);
        return { kind: "error", error: "v4_balance_read_failed" };
    }

    // 4) Sign the V4 Claim (7-field, domain version "4"). Signing for the live
    //    balance; claimByTwitter sweeps the balance at execute time (>= signed).
    const account = privateKeyToAccount(backendPk);
    const nonce = `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
    const sig = await account.signTypedData({
        domain: {
            name: "ArcadeTwitterEscrow",
            version: TWITTER_ESCROW_V4_DOMAIN_VERSION,
            chainId: arcTestnet.id,
            verifyingContract: escrow,
        },
        types: TWITTER_ESCROW_V4_CLAIM_TYPES,
        primaryType: "Claim",
        message: {
            positionId,
            slotIndex: BigInt(slotIndex),
            recipient,
            token: usdc,
            amount,
            deadline,
            nonce,
        },
    });

    return {
        kind: "ok",
        payload: {
            escrowVersion: "v4",
            token,
            positionId: positionId.toString(),
            slotIndex,
            recipient,
            escrowToken: usdc,
            escrowAddress: escrow,
            amount: amount.toString(),
            deadline: deadline.toString(),
            nonce,
            sig,
            handle: oauthHandle,
        },
    };
}
