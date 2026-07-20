import { createWalletClient, http, parseAbiItem, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ARC_CHAIN, serverPublicClient } from "@/lib/serverRpc";
import { ADDRESSES } from "@/lib/constants";
import { getTokenFwd, advanceTokenFwdIf } from "@/lib/twitterLaunchPersistence";

/**
 * Token-side fee forwarding. CLANKER fees accrue in BOTH USDC (routed to the
 * handle escrow) and the LAUNCH TOKEN. The token side is sent by the hook direct
 * to the on-chain `creator` = the OPERATOR (for tweet-launches), so it never
 * reaches the attributed @handle. This forwards the operator's accrued token
 * side to the claimant AFTER they've proven ownership (their on-chain USDC
 * claim, verified by the endpoint).
 *
 * Amount owed per slot = Σ RoyaltyPaid(poolId, launchToken).creatorAmount:
 *  - solo launch: slot 0 (launcher) = the full 80% token creator cut.
 *  - reply launch: slot 0 (launcher) = 40% (creatorAmount after the 50/50
 *    creator2 split) and slot 1 (OP) = the creator2 40%, which for 50/50 equals
 *    the same creatorAmount. Both cursors are tracked separately in the DB.
 *
 * Idempotent: reserve-then-execute compare-and-set on the DB cursor BEFORE the
 * transfer (rollback on failure), identical to twitterReplyReconcile.
 */

const HOOK_DEPLOY_BLOCK = 52470498n; // deployments.json arcadeHookDeployBlock; BUMP on hook redeploy

const ROYALTY_PAID = parseAbiItem(
    "event RoyaltyPaid(bytes32 indexed poolId, address indexed creator, uint256 creatorAmount, uint256 treasuryAmount, address currency)",
);

export type ForwardResult =
    | { ok: true; forwarded: false; reason: string }
    | { ok: true; forwarded: true; amountRaw: string; tx: Hex }
    | { ok: false; error: string };

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

    const cursors = await getTokenFwd(poolIdHex);
    if (!cursors) return { ok: true, forwarded: false, reason: "unknown pool" };

    const client = serverPublicClient();

    // Accrued token-side creator fee = Σ RoyaltyPaid(poolId).creatorAmount where
    // currency == the launch token (the token-denominated leg of CLANKER fees).
    let accrued = 0n;
    try {
        const logs = await client.getLogs({
            address: ADDRESSES.arcadeHook as Address,
            event: ROYALTY_PAID,
            args: { poolId: poolIdHex as Hex },
            fromBlock: HOOK_DEPLOY_BLOCK,
            toBlock: "latest",
        });
        for (const l of logs) {
            const currency = (l.args.currency ?? "0x") as string;
            if (currency.toLowerCase() !== launchToken.toLowerCase()) continue; // USDC leg
            accrued += (l.args.creatorAmount ?? 0n) as bigint;
        }
    } catch (e) {
        return { ok: false, error: `getLogs failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    const already = BigInt((slotIndex === 0 ? cursors.slot0 : cursors.slot1) || "0");
    const owed = accrued - already;
    if (owed <= 0n) return { ok: true, forwarded: false, reason: "nothing new to forward" };

    // Reserve the delta atomically BEFORE the transfer (idempotency + concurrency).
    const reserved = await advanceTokenFwdIf(poolIdHex, slotIndex, already.toString(), (already + owed).toString());
    if (!reserved) return { ok: true, forwarded: false, reason: "already forwarded / concurrent run" };

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
