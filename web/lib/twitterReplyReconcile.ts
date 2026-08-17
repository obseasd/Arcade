import {
    createWalletClient,
    http,
    parseAbiItem,
    erc20Abi,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ARC_CHAIN, serverReadClient } from "@/lib/serverRpc";
import { ADDRESSES, ARCADE_HOOK_DEPLOY_BLOCK } from "@/lib/constants";
import { scanLogsChunked, CHUNK_SMALL } from "@/lib/eventScan";
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
 * slot 1. Idempotent, credits only the delta since the last run (tracked in DB).
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

    // Fallback-aware client (drpc/arcscan-first), NOT the chain-default RPC.
    const publicClient = serverReadClient();

    // Sum the operator's accrual = Σ RoyaltyPaid(poolId).creatorAmount, USDC side.
    // Arc caps eth_getLogs ranges at ~10k blocks AND ignores indexed-topic
    // filters, so we (a) walk in ≤10k backward windows bounded to the hook's
    // deploy block via the shared chunked scanner, and (b) re-filter poolId +
    // currency in JS. A partial scan (RPC stress) under-counts -> we credit less
    // this run and the delta is picked up on a later run (the accrual is
    // cumulative and gated by the DB cursor), never a silent no-credit that
    // strands the original poster's half.
    let accrued = 0n;
    let latest: bigint;
    try {
        latest = await publicClient.getBlockNumber();
    } catch (e) {
        return { ok: false, error: `getBlockNumber failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const deployBlock = ARCADE_HOOK_DEPLOY_BLOCK > 0n ? ARCADE_HOOK_DEPLOY_BLOCK : 0n;
    const maxBack = latest > deployBlock ? latest - deployBlock + 1n : latest + 1n;

    const logs = await scanLogsChunked(
        publicClient,
        { address: hook, event: ROYALTY_PAID, args: { poolId: poolIdHex as Hex } },
        latest,
        { maxBack, chunk: CHUNK_SMALL, label: `replyReconcile ${poolIdHex.slice(0, 10)}` },
    );
    const wantPool = poolIdHex.toLowerCase();
    const wantUsdc = usdc.toLowerCase();
    for (const l of logs) {
        // Arc ignores topic filters -> re-check poolId (and skip the token-side leg).
        if (((l.args?.poolId ?? "0x") as string).toLowerCase() !== wantPool) continue;
        if (((l.args?.currency ?? "0x") as string).toLowerCase() !== wantUsdc) continue;
        accrued += (l.args?.creatorAmount ?? 0n) as bigint;
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
    const positionId = BigInt(poolIdHex); // uint256(PoolId), matches the hook's slot-0 key

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
