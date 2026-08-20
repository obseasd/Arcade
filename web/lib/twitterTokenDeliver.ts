import { parseAbiItem, type Address } from "viem";

import { ADDRESSES, ARCADE_HOOK_DEPLOY_BLOCK } from "@/lib/constants";
import { serverReadClient } from "@/lib/serverRpc";
import { scanLogsChunked, CHUNK_SMALL, MAX_BACK_BLOCKS } from "@/lib/eventScan";
import { forwardTokenSide, forwarderMismatch } from "@/lib/twitterTokenForward";
import {
    getDeliverablePools,
    getDeliverScannedBlock,
    setDeliverScannedBlock,
    recordClaimRecipient,
} from "@/lib/twitterLaunchPersistence";
import { isDbConfigured } from "@/lib/db";

/** Re-scan overlap (blocks): a partial previous scan (RPC stress) gets a second
 *  chance before the watermark skips its range. Arc has instant finality (no
 *  re-org), so a small overlap is plenty. */
const SCAN_OVERLAP_BLOCKS = 5_000n;

/**
 * Q6 token-delivery safety net (shared by the dedicated cron route AND the
 * tweet-reader cron, so it runs on whichever trigger exists).
 *
 * Tweet/reply-to-launch creator fees have a TOKEN leg the escrow can't hold, so it
 * accrues on the forwarder wallet and is delivered off-chain by a single best-effort
 * client POST right after the USDC claim. If that POST fails and no further USDC fees
 * accrue, the token side would strand until sweepStaleTokenSide forfeits it to the
 * treasury at 180 days -- the creator loses it.
 *
 * This re-plays the delivery: it scans the escrow's on-chain Claimed events (the SAME
 * proof the client POST uses -> a delivery can ONLY ever pay the wallet that actually
 * claimed), maps each (poolId, slot) to its recipient, and calls the idempotent
 * forwardTokenSide for every launched handle pool. Already-delivered slots no-op (DB
 * cursor), so it adds ZERO theft/double-pay surface -- delivery goes from best-effort
 * to guaranteed.
 */

const CLAIMED_EVENT = parseAbiItem(
    "event Claimed(uint256 indexed positionId, uint256 indexed slotIndex, address indexed recipient, address token, uint256 amount)",
);

export interface DeliverResult {
    ran: boolean;
    reason?: string;
    pools?: number;
    claims?: number;
    delivered?: { pool: string; slot: 0 | 1; recipient: string; amountRaw?: string; error?: string }[];
}

export async function deliverPendingTokenSides(): Promise<DeliverResult> {
    if (!isDbConfigured()) return { ran: false, reason: "Postgres not configured" };

    // Never forward from the wrong key: if the on-chain tokenForwarder is set and
    // disagrees with the forwarder key we sign from, bail (same guard as reconcile).
    const mism = await forwarderMismatch();
    if (mism) return { ran: false, reason: mism };

    const escrow = ADDRESSES.twitterEscrow as Address;
    if (!escrow || /^0x0*$/.test(escrow)) return { ran: false, reason: "escrow not configured" };

    const client = serverReadClient();
    let head: bigint;
    try {
        head = await client.getBlockNumber();
    } catch (e) {
        return { ran: false, reason: `getBlockNumber failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    const pools = await getDeliverablePools();
    if (pools.length === 0) return { ran: true, pools: 0, delivered: [] };

    // Bounded, WATERMARKED scan (Q6 LOW-1): scan only blocks since the last run's
    // watermark (minus a small overlap) so per-run cost stays constant instead of
    // growing with chain age, and cap the FIRST run (empty watermark) so it can't
    // blow the budget. Discovered recipients are PERSISTED, so a failed delivery is
    // still retried from the DB indefinitely even after the watermark moves past it.
    const deployBlock = ARCADE_HOOK_DEPLOY_BLOCK > 0n ? ARCADE_HOOK_DEPLOY_BLOCK : 0n;
    const watermark = await getDeliverScannedBlock();
    let fromBlock = watermark > deployBlock ? watermark : deployBlock;
    fromBlock = fromBlock > deployBlock + SCAN_OVERLAP_BLOCKS ? fromBlock - SCAN_OVERLAP_BLOCKS : deployBlock;
    let maxBack = head >= fromBlock ? head - fromBlock + 1n : head + 1n;
    if (maxBack > MAX_BACK_BLOCKS) maxBack = MAX_BACK_BLOCKS;

    // Chunked scan of Claimed events in the bounded window (Arc caps getLogs at ~10k
    // blocks and ignores indexed-topic filters, so scanLogsChunked walks windows).
    let logs: unknown[];
    try {
        logs = (await scanLogsChunked(
            client,
            { address: escrow, event: CLAIMED_EVENT },
            head,
            { maxBack, chunk: CHUNK_SMALL, label: "deliverToken Claimed" },
        )) as unknown[];
    } catch (e) {
        return { ran: false, reason: `Claimed scan failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // positionId (decimal string) -> { slot -> latest-claim recipient }. The escrow
    // slot REOPENS after each claim, so a handle owner can re-verify and claim from a
    // new wallet; we must deliver the token side to the MOST RECENT claim (highest
    // block, then logIndex), not whatever the scan happened to visit last (audit M-2).
    type Winner = { recipient: Address; block: bigint; logIndex: number };
    const claimedBy = new Map<string, { 0?: Winner; 1?: Winner }>();
    for (const log of logs) {
        const l = log as {
            args?: { positionId?: bigint; slotIndex?: bigint; recipient?: string };
            blockNumber?: bigint;
            logIndex?: number;
        };
        const a = l.args;
        if (!a || a.positionId === undefined || a.slotIndex === undefined || !a.recipient) continue;
        const slot = a.slotIndex === 0n ? 0 : a.slotIndex === 1n ? 1 : -1;
        if (slot < 0) continue;
        const block = l.blockNumber ?? 0n;
        const logIndex = l.logIndex ?? 0;
        const key = a.positionId.toString();
        const entry = claimedBy.get(key) ?? {};
        const cur = entry[slot as 0 | 1];
        if (!cur || block > cur.block || (block === cur.block && logIndex > cur.logIndex)) {
            entry[slot as 0 | 1] = { recipient: a.recipient as Address, block, logIndex };
        }
        claimedBy.set(key, entry);
    }

    // Advance the watermark now that this window is scanned. On a scan error we
    // returned above, so it only moves after a completed scan.
    await setDeliverScannedBlock(head).catch(() => {});

    // Deliver each claimed slot's token side, driven by the DB's PERSISTED recipient
    // (durable across runs) unioned with any recipient freshly seen in this scan (the
    // latest, for a re-claim). forwardTokenSide is idempotent + per-pool locked.
    const delivered: DeliverResult["delivered"] = [];
    for (const { poolId, token, slot0Recipient, slot1Recipient } of pools) {
        let positionId: bigint;
        try {
            positionId = BigInt(poolId);
        } catch {
            continue; // malformed pool_id
        }
        const scanned = claimedBy.get(positionId.toString());
        for (const slot of [0, 1] as const) {
            const scannedRec = scanned?.[slot]?.recipient ?? null;
            const persisted = (slot === 0 ? slot0Recipient : slot1Recipient) as Address | null;
            const recipient = scannedRec ?? persisted;
            if (!recipient) continue; // nobody has claimed this slot yet
            // Persist a newly-discovered / rotated recipient for durable retry.
            if (scannedRec && scannedRec.toLowerCase() !== (persisted ?? "").toLowerCase()) {
                await recordClaimRecipient(poolId, slot, scannedRec).catch(() => {});
            }
            try {
                const r = await forwardTokenSide(poolId, slot, recipient, token as Address);
                if (r.ok && r.forwarded) {
                    delivered.push({ pool: poolId, slot, recipient, amountRaw: r.amountRaw });
                } else if (!r.ok) {
                    delivered.push({ pool: poolId, slot, recipient, error: r.error });
                }
            } catch (e) {
                delivered.push({ pool: poolId, slot, recipient, error: e instanceof Error ? e.message : String(e) });
            }
        }
    }

    return { ran: true, pools: pools.length, claims: claimedBy.size, delivered };
}
