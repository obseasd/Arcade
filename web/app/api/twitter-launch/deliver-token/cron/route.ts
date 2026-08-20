import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { parseAbiItem, type Address } from "viem";

import { ADDRESSES, ARCADE_HOOK_DEPLOY_BLOCK } from "@/lib/constants";
import { serverReadClient } from "@/lib/serverRpc";
import { scanLogsChunked, CHUNK_SMALL } from "@/lib/eventScan";
import { forwardTokenSide, forwarderMismatch } from "@/lib/twitterTokenForward";
import { getDeliverablePools } from "@/lib/twitterLaunchPersistence";
import { isDbConfigured } from "@/lib/db";

/**
 * Q6 token-delivery safety net (cron).
 *
 * Tweet/reply-to-launch creator fees have a TOKEN leg the escrow can't hold, so it
 * accrues on the forwarder wallet and is delivered off-chain by a single best-effort
 * client POST (/api/twitter-launch/forward-token) right after the USDC claim. If that
 * POST fails (tab closed, network/RPC flake) and no further USDC fees ever accrue, the
 * token side would strand on the forwarder until sweepStaleTokenSide forfeits it to the
 * treasury at 180 days -- the creator loses it.
 *
 * This cron re-plays the delivery: it scans the escrow's on-chain Claimed events (the
 * SAME proof the client POST uses -- so a delivery can ONLY ever pay the wallet that
 * actually claimed), maps each (poolId, slot) to its recipient, and calls the idempotent
 * forwardTokenSide for every launched handle pool. Already-delivered slots are a no-op
 * (DB cursor), so it adds ZERO theft/double-pay surface -- it just turns delivery from
 * best-effort into guaranteed.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLAIMED_EVENT = parseAbiItem(
    "event Claimed(uint256 indexed positionId, uint256 indexed slotIndex, address indexed recipient, address token, uint256 amount)",
);

export async function POST(req: NextRequest) {
    // Auth: a dedicated KEEPER_CRON_SECRET (preferred) or the shared
    // COMPOUNDER_CRON_SECRET, constant-time matched (same gate as the keeper cron).
    const secrets = [process.env.KEEPER_CRON_SECRET, process.env.COMPOUNDER_CRON_SECRET].filter(
        (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (secrets.length === 0) {
        return NextResponse.json(
            { error: "KEEPER_CRON_SECRET (or COMPOUNDER_CRON_SECRET) not configured" },
            { status: 500 },
        );
    }
    const auth = req.headers.get("authorization");
    const ok =
        !!auth &&
        secrets.some((s) => {
            const expected = `Bearer ${s}`;
            if (auth.length !== expected.length) return false;
            return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
        });
    if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!isDbConfigured()) {
        return NextResponse.json({ ran: false, reason: "Postgres not configured" }, { status: 200 });
    }

    // Never forward from the wrong key: if the on-chain tokenForwarder is set and
    // disagrees with the forwarder key we sign from, bail (same guard as reconcile).
    const mism = await forwarderMismatch();
    if (mism) return NextResponse.json({ ran: false, reason: mism }, { status: 200 });

    const escrow = ADDRESSES.twitterEscrow as Address;
    if (!escrow || /^0x0*$/.test(escrow)) {
        return NextResponse.json({ ran: false, reason: "escrow not configured" }, { status: 200 });
    }

    const pools = await getDeliverablePools();
    if (pools.length === 0) {
        return NextResponse.json({ ran: true, pools: 0, delivered: [] });
    }

    const client = serverReadClient();
    let head: bigint;
    try {
        head = await client.getBlockNumber();
    } catch (e) {
        return NextResponse.json(
            { ran: false, reason: `getBlockNumber failed: ${e instanceof Error ? e.message : String(e)}` },
            { status: 200 },
        );
    }
    const deployBlock = ARCADE_HOOK_DEPLOY_BLOCK > 0n ? ARCADE_HOOK_DEPLOY_BLOCK : 0n;
    const maxBack = head > deployBlock ? head - deployBlock + 1n : head + 1n;

    // One chunked scan of every Claimed event (Arc caps getLogs at ~10k blocks and
    // ignores indexed-topic filters, so scanLogsChunked walks windows and we key in JS).
    let logs: unknown[];
    try {
        logs = (await scanLogsChunked(
            client,
            { address: escrow, event: CLAIMED_EVENT },
            head,
            { maxBack, chunk: CHUNK_SMALL, label: "deliverToken Claimed" },
        )) as unknown[];
    } catch (e) {
        return NextResponse.json(
            { ran: false, reason: `Claimed scan failed: ${e instanceof Error ? e.message : String(e)}` },
            { status: 200 },
        );
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
    const delivered: { pool: string; slot: 0 | 1; recipient: string; amountRaw?: string; error?: string }[] = [];
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

    return NextResponse.json({ ran: true, pools: pools.length, claims: claimedBy.size, delivered });
}
