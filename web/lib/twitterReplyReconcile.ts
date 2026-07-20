import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbiItem,
    erc20Abi,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ADDRESSES } from "@/lib/constants";
import { getReplyLaunchByPool, advanceSlot1CreditedIf } from "@/lib/twitterLaunchPersistence";

/**
 * On-demand reconciliation for reply-to-launch (50/50). On each swap of a
 * reply-launched token the hook silently sends the original poster's half of the
 * creator fee to the OPERATOR (creator2). This sweeps that accrued half into the
 * escrow's SLOT 1 (keyed by uint256(poolId), matching the hook's slot-0 key), so
 * the original poster can claim it exactly like a normal handle slot.
 *
 * How the accrued amount is derived WITHOUT a creator2 event: the hook emits
 * RoyaltyPaid(poolId, creator, creatorAmount, treasuryAmount, currency) with
 * creatorAmount = the LAUNCHER's cut AFTER the split. Since the split is 50/50,
 * the operator's cut equals that same creatorAmount (USDC side only). Summing
 * RoyaltyPaid.creatorAmount over the pool therefore equals the operator's total
 * accrual. We subtract what's already been credited (DB) and sweep the delta.
 *
 * Requires: the operator (COMPOUNDER_OPERATOR_PRIVATE_KEY) is an allowedCrediter
 * on the escrow (owner/Safe runs escrow.setCrediter(operator, true) once).
 */

const ARC_CHAIN = {
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
} as const;

// The hook's deploy block (deployments.json arcadeHookDeployBlock) bounds the
// RoyaltyPaid scan. BUMP with the hook address at each redeploy.
const HOOK_DEPLOY_BLOCK = 52470498n;

const ROYALTY_PAID = parseAbiItem(
    "event RoyaltyPaid(bytes32 indexed poolId, address indexed creator, uint256 creatorAmount, uint256 treasuryAmount, address currency)",
);

const CREDIT_SLOT_ABI = [
    {
        type: "function",
        name: "creditSlot",
        stateMutability: "nonpayable",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [],
    },
] as const;

export type ReconcileResult =
    | { ok: true; credited: false; reason: string }
    | { ok: true; credited: true; amountMicros: string; txTransfer: Hex; txCredit: Hex }
    | { ok: false; error: string };

/**
 * Reconcile one reply-launch pool: sweep the operator's accrued half into escrow
 * slot 1. Idempotent — credits only the delta since the last run (tracked in DB).
 * poolIdHex is the bytes32 PoolId (0x…) recorded at launch.
 */
export async function reconcileReplySlot(poolIdHex: string): Promise<ReconcileResult> {
    const operatorKey = process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY as Hex | undefined;
    if (!operatorKey || !/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) {
        return { ok: false, error: "operator key missing/malformed" };
    }
    const hook = ADDRESSES.arcadeHook as Address;
    const escrow = ADDRESSES.twitterEscrow as Address;
    const usdc = ADDRESSES.usdc as Address;
    if (!hook || hook === "0x0000000000000000000000000000000000000000") {
        return { ok: false, error: "hook not configured" };
    }
    if (!escrow || escrow === "0x0000000000000000000000000000000000000000") {
        return { ok: false, error: "escrow not configured" };
    }

    const row = await getReplyLaunchByPool(poolIdHex);
    if (!row) return { ok: true, credited: false, reason: "not a reply-launch (no slot-1 owner)" };

    const publicClient = createPublicClient({ chain: ARC_CHAIN, transport: http() });

    // Sum the operator's accrual = Σ RoyaltyPaid(poolId).creatorAmount, USDC side.
    let accrued = 0n;
    try {
        const logs = await publicClient.getLogs({
            address: hook,
            event: ROYALTY_PAID,
            args: { poolId: poolIdHex as Hex },
            fromBlock: HOOK_DEPLOY_BLOCK,
            toBlock: "latest",
        });
        for (const l of logs) {
            const currency = (l.args.currency ?? "0x") as string;
            if (currency.toLowerCase() !== usdc.toLowerCase()) continue; // token-side leg
            accrued += (l.args.creatorAmount ?? 0n) as bigint;
        }
    } catch (e) {
        return { ok: false, error: `getLogs failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    const already = BigInt(row.slot1CreditedUsdc || "0");
    const owed = accrued - already;
    if (owed <= 0n) return { ok: true, credited: false, reason: "nothing new to credit" };

    // Audit fix (idempotency + concurrency): RESERVE the delta by advancing the
    // DB cursor BEFORE any on-chain action. A compare-and-set on the row means
    // only ONE run (concurrent or retried) proceeds for a given delta, and a
    // crash AFTER the on-chain credit can never re-sweep it. On on-chain failure
    // we roll the cursor back so a later run retries; if that rollback itself
    // fails the worst case is UNDER-credit (funds stay safe in the operator
    // wallet), never a double-spend.
    const reserved = await advanceSlot1CreditedIf(poolIdHex, already.toString(), (already + owed).toString());
    if (!reserved) return { ok: true, credited: false, reason: "already reconciled / concurrent run" };

    const account = privateKeyToAccount(operatorKey);
    const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: http() });
    const positionId = BigInt(poolIdHex); // uint256(PoolId) — matches the hook's slot-0 key

    let txTransfer: Hex;
    let txCredit: Hex;
    try {
        // Deliver USDC to the escrow FIRST, then credit slot 1 (the escrow's
        // balance-diff invariant: amount <= balanceOf - creditedTotal).
        txTransfer = await walletClient.writeContract({
            address: usdc,
            abi: erc20Abi,
            functionName: "transfer",
            args: [escrow, owed],
        });
        await publicClient.waitForTransactionReceipt({ hash: txTransfer });

        txCredit = await walletClient.writeContract({
            address: escrow,
            abi: CREDIT_SLOT_ABI,
            functionName: "creditSlot",
            args: [positionId, 1n, usdc, owed],
        });
        await publicClient.waitForTransactionReceipt({ hash: txCredit });
    } catch (e) {
        // Roll back the reservation so the delta is retried next run.
        await advanceSlot1CreditedIf(poolIdHex, (already + owed).toString(), already.toString()).catch(() => {});
        return { ok: false, error: `credit failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    return { ok: true, credited: true, amountMicros: owed.toString(), txTransfer, txCredit };
}
