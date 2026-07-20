import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { listReplyLaunchPools } from "@/lib/twitterLaunchPersistence";
import { reconcileReplySlot } from "@/lib/twitterReplyReconcile";

/**
 * Reply-to-launch reconciliation: sweep each reply-launch's operator-accrued
 * half into the original poster's escrow slot 1 (see twitterReplyReconcile.ts).
 *
 * Two modes:
 *  - POST { poolId }  -> reconcile ONE pool (call this right before authorising
 *                        an original poster's claim, so their slot is funded).
 *  - POST (no body)   -> batch every reply-launch pool (a slow safety-net cron;
 *                        e.g. weekly). Optional; on-demand-at-claim is enough.
 *
 * Auth: the tweet-launch cron secret (same precedence as the cron).
 * Prereq: the operator must be an allowedCrediter on the escrow.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BATCH = 20;

export async function POST(req: NextRequest) {
    const secret =
        process.env.TWEET_LAUNCH_CRON_SECRET ??
        process.env.KEEPER_CRON_SECRET ??
        process.env.COMPOUNDER_CRON_SECRET;
    if (!secret) return NextResponse.json({ error: "cron secret not configured" }, { status: 500 });
    if (req.headers.get("authorization") !== `Bearer ${secret}`) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!isDbConfigured()) return NextResponse.json({ ran: false, reason: "DB not configured" }, { status: 503 });

    // Optional { poolId } body for the single-pool (claim-time) path.
    let poolId: string | undefined;
    try {
        const body = (await req.json()) as { poolId?: string };
        poolId = typeof body?.poolId === "string" ? body.poolId : undefined;
    } catch {
        /* no body -> batch mode */
    }

    if (poolId) {
        const result = await reconcileReplySlot(poolId);
        return NextResponse.json({ ran: true, mode: "single", poolId, result });
    }

    const pools = (await listReplyLaunchPools()).slice(0, MAX_BATCH);
    const results: { poolId: string; result: Awaited<ReturnType<typeof reconcileReplySlot>> }[] = [];
    for (const p of pools) {
        results.push({ poolId: p, result: await reconcileReplySlot(p) });
    }
    const credited = results.filter((r) => r.result.ok && "credited" in r.result && r.result.credited).length;
    return NextResponse.json({ ran: true, mode: "batch", scanned: pools.length, credited, results });
}
