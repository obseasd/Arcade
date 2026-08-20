import { parseAbiItem, type Address } from "viem";

import { ADDRESSES, ARCADE_HOOK_DEPLOY_BLOCK } from "@/lib/constants";
import { serverReadClient } from "@/lib/serverRpc";
import { scanLogsChunked, CHUNK_SMALL } from "@/lib/eventScan";
import { forwardTokenSide, forwarderMismatch } from "@/lib/twitterTokenForward";
import { getDeliverablePools } from "@/lib/twitterLaunchPersistence";
import { isDbConfigured } from "@/lib/db";

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

    const pools = await getDeliverablePools();
    if (pools.length === 0) return { ran: true, pools: 0, delivered: [] };

    const client = serverReadClient();
    let head: bigint;
    try {
        head = await client.getBlockNumber();
    } catch (e) {
        return { ran: false, reason: `getBlockNumber failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const deployBlock = ARCADE_HOOK_DEPLOY_BLOCK > 0n ? ARCADE_HOOK_DEPLOY_BLOCK : 0n;
    const maxBack = head > deployBlock ? head - deployBlock + 1n : head + 1n;

    // One chunked scan of every Claimed event (Arc caps getLogs at ~10k blocks and
    // ignores indexed-topic filters, so scanLogsChunked walks windows; we key in JS).
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

    // positionId (decimal string) -> { slot -> recipient }. Each slot is claimed once.
    const claimedBy = new Map<string, { 0?: Address; 1?: Address }>();
    for (const log of logs) {
        const a = (log as { args?: { positionId?: bigint; slotIndex?: bigint; recipient?: string } }).args;
        if (!a || a.positionId === undefined || a.slotIndex === undefined || !a.recipient) continue;
        const slot = a.slotIndex === 0n ? 0 : a.slotIndex === 1n ? 1 : -1;
        if (slot < 0) continue;
        const key = a.positionId.toString();
        const entry = claimedBy.get(key) ?? {};
        entry[slot as 0 | 1] = a.recipient as Address;
        claimedBy.set(key, entry);
    }

    // Deliver each claimed slot's token side. forwardTokenSide is idempotent
    // (already-delivered -> no-op), so re-runs and partial runs are safe.
    const delivered: DeliverResult["delivered"] = [];
    for (const { poolId, token } of pools) {
        let positionId: bigint;
        try {
            positionId = BigInt(poolId);
        } catch {
            continue; // malformed pool_id
        }
        const claims = claimedBy.get(positionId.toString());
        if (!claims) continue; // nobody has claimed this pool yet -> nothing to deliver
        for (const slot of [0, 1] as const) {
            const recipient = claims[slot];
            if (!recipient) continue;
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
