import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { listHandleLaunchPools, sweepStaleTokenSide, forfeitStaleUsdc } from "@/lib/twitterTokenSweep";
import { onchainTokenForwarder } from "@/lib/twitterTokenForward";

/**
 * Stale token-side sweep cron (P2 level 4, C). Walks every handle-launch pool and
 * sweeps the forwarder's held launch-token balance to the treasury Safe once the
 * escrow slot-0 forfeit clock (180d, reset on each claim) has elapsed -- i.e. the
 * handle is abandoned. Mirrors the USDC-side forfeit so an unclaimed token side
 * cannot pile up on the forwarder EOA indefinitely. Idempotent (a swept balance
 * reads 0 next run). Bounded per invocation to stay under the function timeout;
 * a periodic trigger catches the rest.
 *
 * Auth: KEEPER_CRON_SECRET (preferred) or COMPOUNDER_CRON_SECRET, same bearer
 * scheme as the keeper cron. Wire to a scheduler (cron-job.org) at a daily-ish
 * cadence -- there is no urgency (staleness is measured in months).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_WRITES_PER_RUN = 20; // cap on-chain writes (token sweeps + USDC forfeits)
const TIME_BUDGET_MS = 50_000; // stop scanning before the 60s function timeout

export async function POST(req: NextRequest) {
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
    const authed =
        !!auth &&
        secrets.some((s) => {
            const expected = `Bearer ${s}`;
            if (auth.length !== expected.length) return false;
            return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
        });
    if (!authed) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // Dormant until the DEDICATED forwarder is configured on-chain (mainnet). In
    // legacy mode (tokenForwarder == 0) the forwarder key falls back to the
    // operator, which holds legacy token fees we do NOT want this cron to move --
    // so bail entirely (audit LOW-3: structurally inert, not merely time-inert).
    const onchainFwd = await onchainTokenForwarder();
    const ZERO = "0x0000000000000000000000000000000000000000";
    if (!onchainFwd || onchainFwd.toLowerCase() === ZERO) {
        return NextResponse.json({ ok: true, skipped: "tokenForwarder not set (legacy mode)" });
    }

    const startedAt = Date.now();
    const pools = await listHandleLaunchPools();
    const preNotes: string[] = [];
    if (pools.length >= 1000) preNotes.push("handle-launch list capped at 1000 (paginate when it grows past this)");
    let scanned = 0;
    let swept = 0;
    let forfeited = 0;
    let errors = 0;
    let writes = 0;
    const sweeps: { poolId: string; token: string; amountRaw: string; tx: string; to: string }[] = [];
    const forfeits: { poolId: string; slot: number; amountRaw: string; tx: string }[] = [];
    const notes: string[] = [...preNotes];

    for (const p of pools) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
            notes.push(`time budget hit after ${scanned}/${pools.length} pools`);
            break;
        }
        if (writes >= MAX_WRITES_PER_RUN) {
            notes.push(`write cap (${MAX_WRITES_PER_RUN}) hit after ${scanned}/${pools.length} pools`);
            break;
        }
        scanned += 1;
        // 1) TOKEN side FIRST -- reads the slot-0 forfeit anchor. Track whether the
        //    token leg SETTLED (swept, or nothing to sweep) vs errored.
        let tokenSettled = false;
        try {
            const r = await sweepStaleTokenSide(p.poolId, p.token);
            if (r.ok) {
                tokenSettled = true;
                if (r.swept) {
                    swept += 1;
                    writes += 1;
                    sweeps.push({ poolId: p.poolId, token: p.token, amountRaw: r.amountRaw, tx: r.tx, to: r.to });
                }
            } else {
                errors += 1;
            }
        } catch {
            errors += 1;
        }
        // 2) USDC side -- ONLY if the token leg settled. forfeitStaleToTreasury
        //    RESETS the slot anchor, so forfeiting while the token sweep is still
        //    failing would zero the anchor and strand the token forever (audit
        //    MEDIUM-2). Slot 0 then slot 1; retry both next run on a token error.
        if (tokenSettled) {
            for (const slot of [0, 1] as const) {
                try {
                    const f = await forfeitStaleUsdc(p.poolId, slot);
                    if (f.ok && f.forfeited) {
                        forfeited += 1;
                        writes += 1;
                        forfeits.push({ poolId: p.poolId, slot, amountRaw: f.amountRaw, tx: f.tx });
                    } else if (!f.ok) {
                        errors += 1;
                    }
                } catch {
                    errors += 1;
                }
            }
        }
    }

    return NextResponse.json({
        ok: true,
        total: pools.length,
        scanned,
        swept,
        forfeited,
        errors,
        sweeps,
        forfeits,
        notes,
    });
}
