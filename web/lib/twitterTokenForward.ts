import { createWalletClient, http, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ARC_CHAIN, serverPublicClient } from "@/lib/serverRpc";
import { getTokenFwd, advanceTokenFwdIf, getReplyLaunchByPool } from "@/lib/twitterLaunchPersistence";
import { REPLY_SPLIT_BPS } from "@/lib/twitterLaunch";

/**
 * Token-side fee forwarding. CLANKER fees accrue in BOTH USDC (routed to the
 * handle escrow) and the LAUNCH TOKEN. The token side is sent by the hook direct
 * to the on-chain `creator` = the OPERATOR (for tweet-launches), so it never
 * reaches the attributed @handle. This forwards the operator's accrued token
 * side to the claimant AFTER they've proven ownership (their on-chain USDC
 * claim, verified by the endpoint).
 *
 * HOW WE KNOW THE AMOUNT OWED, WITHOUT SCANNING LOGS: forwarding TRANSFERS the
 * token out of the operator, so the operator's remaining balance of a given
 * launch token IS the un-forwarded token-side fee for that token (the operator
 * gets no CLANKER allocation and never trades, so it holds nothing else of it;
 * the treasury 20% goes to the Safe, the USDC side to the escrow). Total ever
 * accrued = balance + already-forwarded. We split that by the fixed creator2
 * ratio into the two slots and subtract each slot's forwarded cursor.
 *
 *   solo launch (creator2Bps 0): slot 0 (launcher) owns 100% of the token cut.
 *   reply launch (creator2Bps 5000, both cuts land on the operator): slots 0/1
 *     each own bps-proportional halves; owed(slot) = slotTotal - slotForwarded.
 *
 * This is O(1) reads (one balanceOf), so it never hits the Arc RPC's 10k-block
 * eth_getLogs cap that made the old log-scan approach time the function out.
 *
 * Idempotent: reserve-then-execute compare-and-set on the DB cursor BEFORE the
 * transfer (rollback on failure), identical to twitterReplyReconcile.
 */

export type ForwardResult =
    | { ok: true; forwarded: false; reason: string }
    | { ok: true; forwarded: true; amountRaw: string; tx: Hex }
    | { ok: false; error: string };

/** The operator EOA that holds token-side fees (createLaunch msg.sender). Derived
 *  from the operator key; null if the key is unset/malformed. */
function operatorAddress(): Address | null {
    const key = process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY as Hex | undefined;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
    return privateKeyToAccount(key).address;
}

/** creator2 split (bps) for a pool: REPLY_SPLIT_BPS for a reply-launch, else 0. */
async function creator2BpsFor(poolIdHex: string): Promise<bigint> {
    const reply = await getReplyLaunchByPool(poolIdHex);
    return reply ? BigInt(REPLY_SPLIT_BPS) : 0n;
}

/**
 * Compute the launch-token amount owed to (poolId, slotIndex) from the operator's
 * live balance and the per-slot forwarded cursors. Returns { owed, already } so
 * the executing path can reserve the exact delta. Owed is clamped to >= 0.
 */
async function computeOwed(
    poolIdHex: string,
    slotIndex: 0 | 1,
    launchToken: Address,
): Promise<{ owed: bigint; already: bigint } | null> {
    const operator = operatorAddress();
    if (!operator) return null;
    const cursors = await getTokenFwd(poolIdHex);
    if (!cursors) return null;

    const fwd0 = BigInt(cursors.slot0 || "0");
    const fwd1 = BigInt(cursors.slot1 || "0");

    const client = serverPublicClient();
    const balance = (await client.readContract({
        address: launchToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [operator],
    })) as bigint;

    // Everything ever accrued to the operator for this token = still-held +
    // already forwarded out.
    const totalAccrued = balance + fwd0 + fwd1;
    const bps = await creator2BpsFor(poolIdHex);
    const slotTotal =
        slotIndex === 0 ? (totalAccrued * (10_000n - bps)) / 10_000n : (totalAccrued * bps) / 10_000n;
    const already = slotIndex === 0 ? fwd0 : fwd1;
    let owed = slotTotal - already;
    if (owed < 0n) owed = 0n;
    // Never try to move more than is physically held (guards a slot-race / stray
    // deposit); the transfer would revert anyway.
    if (owed > balance) owed = balance;
    return { owed, already };
}

/**
 * Read-only preview of the launch-token amount still owed to (poolId, slotIndex).
 * Does NOT reserve or transfer, so it is safe to call before the user claims (to
 * show the "+ N TICKER" they will receive). Returns "0" on any error/unknown pool.
 */
export async function previewTokenSideOwed(
    poolIdHex: string,
    slotIndex: 0 | 1,
    launchToken: Address,
): Promise<string> {
    try {
        const r = await computeOwed(poolIdHex, slotIndex, launchToken);
        return r && r.owed > 0n ? r.owed.toString() : "0";
    } catch {
        return "0";
    }
}

/**
 * Forward the launch-token creator fees owed to (poolId, slotIndex) to
 * `recipient`. `launchToken` is the token whose fees we forward.
 */
export async function forwardTokenSide(
    poolIdHex: string,
    slotIndex: 0 | 1,
    recipient: Address,
    launchToken: Address,
): Promise<ForwardResult> {
    const operatorKey = process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY as Hex | undefined;
    if (!operatorKey || !/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) {
        return { ok: false, error: "operator key missing/malformed" };
    }

    let computed: { owed: bigint; already: bigint } | null;
    try {
        computed = await computeOwed(poolIdHex, slotIndex, launchToken);
    } catch (e) {
        return { ok: false, error: `balance read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!computed) return { ok: true, forwarded: false, reason: "unknown pool / operator" };

    const { owed, already } = computed;
    if (owed <= 0n) return { ok: true, forwarded: false, reason: "nothing new to forward" };

    // Reserve the delta atomically BEFORE the transfer (idempotency + concurrency).
    const reserved = await advanceTokenFwdIf(poolIdHex, slotIndex, already.toString(), (already + owed).toString());
    if (!reserved) return { ok: true, forwarded: false, reason: "already forwarded / concurrent run" };

    const client = serverPublicClient();
    const account = privateKeyToAccount(operatorKey);
    const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: http() });
    let tx: Hex;
    try {
        tx = await walletClient.writeContract({
            address: launchToken,
            abi: erc20Abi,
            functionName: "transfer",
            args: [recipient, owed],
        });
        await client.waitForTransactionReceipt({ hash: tx });
    } catch (e) {
        // Roll the cursor back so a retry re-attempts (worst case: under-forward,
        // tokens stay safe on the operator).
        await advanceTokenFwdIf(poolIdHex, slotIndex, (already + owed).toString(), already.toString()).catch(() => {});
        return { ok: false, error: `transfer failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    return { ok: true, forwarded: true, amountRaw: owed.toString(), tx };
}
