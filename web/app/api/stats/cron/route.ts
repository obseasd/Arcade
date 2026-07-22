import { NextRequest, NextResponse } from "next/server";
import { getAggregateStats, getGoldskyStats } from "@/lib/stats";
import { insertSnapshot, lastCronSnapshotIso } from "@/lib/statsPersistence";
import { isDbConfigured } from "@/lib/db";

/**
 * Audit 2026-06-18 M-02: idempotency window. If a cron-tagged row was
 * written within the last MIN_CRON_INTERVAL_MS, refuse to run the next
 * scan and return 200 with `skipped:true`. Protects against two
 * concurrent cron firings (GitHub Actions cron + manual replay) both
 * inserting near-duplicate rows that pollute the time-series.
 * Generous (45 min) so the hourly cron cadence always passes; only a
 * second cron call inside the hour bounces.
 */
const MIN_CRON_INTERVAL_MS = 45 * 60 * 1000;

/**
 * Hourly cron endpoint that snapshots the live /stats aggregate into
 * Postgres. Triggered by .github/workflows/stats-snapshot.yml so we
 * stay on the GitHub Actions free tier and do not consume the Vercel
 * Hobby cron quota (which caps at 2 cron jobs per project).
 *
 * Auth: shared-secret bearer in the Authorization header. The matching
 * secret lives in two places:
 *   - Vercel env: STATS_CRON_SECRET (production + preview scope)
 *   - GitHub repo secret: STATS_CRON_SECRET (consumed by the workflow)
 * Rotate them together. Never log the header or include it in error
 * responses; the catch block deliberately swallows error.message
 * verbatim and returns a generic shape instead.
 *
 * Behaviour on the rare failure modes:
 *   - DB not configured: returns 200 with persisted:false so the cron
 *     run does not page anyone while we wait for the Vercel Postgres
 *     attach to complete. Re-running it after attach lands the row.
 *   - RPC scan failed mid-flight: getAggregateStats sets `truncated:true`
 *     internally rather than throwing; the partial snapshot still
 *     persists so we never have a gap in the time-series.
 *   - DB insert failed: returns 500 so the workflow marks the run as
 *     failed and GitHub emails the repo owner.
 */
export const dynamic = "force-dynamic";

// The scan can take 30–60s on a wide history; bump the function
// budget from the default 10s. Vercel Hobby caps at 60s for serverless
// functions — set the route to the upper end to give the RPC scan
// room without hitting a hard timeout.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
    const secret = process.env.STATS_CRON_SECRET;
    if (!secret) {
        // Misconfigured: refuse to run the expensive scan rather than
        // exposing an unauthenticated write endpoint. The first cron
        // run after a fresh deploy will fail loudly until the env is set.
        return NextResponse.json(
            { error: "STATS_CRON_SECRET not configured" },
            { status: 500 },
        );
    }

    const auth = req.headers.get("authorization");
    const expected = `Bearer ${secret}`;
    // Constant-time-ish compare to dissuade casual timing probes.
    // The standard-library-only path here uses Buffer length equality
    // first to avoid an early return; full crypto.timingSafeEqual would
    // be nicer but introduces a Node runtime requirement we don't need.
    if (!auth || auth.length !== expected.length || auth !== expected) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isDbConfigured()) {
        // Soft-fail mode so the first cron run after attaching Postgres
        // doesn't immediately page. Returns 200 with a clear flag.
        return NextResponse.json(
            {
                persisted: false,
                reason: "Postgres not configured (POSTGRES_URL absent)",
            },
            { status: 200 },
        );
    }

    // Audit M-02: idempotency check. Cheap (1 SELECT) and runs BEFORE
    // the ~30-60s RPC scan, so a redundant cron call returns in
    // sub-second instead of burning a full scan + insert.
    const lastIso = await lastCronSnapshotIso();
    if (lastIso) {
        const sinceMs = Date.now() - new Date(lastIso).getTime();
        if (sinceMs < MIN_CRON_INTERVAL_MS) {
            return NextResponse.json(
                {
                    persisted: false,
                    skipped: true,
                    reason: "Previous cron row too recent",
                    lastCronAt: lastIso,
                    sinceMs,
                },
                { status: 200 },
            );
        }
    }

    // Prefer the Goldsky subgraph: it now indexes the full trade surface
    // (Launchpad curve + V2 pairs + V3 pools + V4 hook, all feeding
    // Global.totalVolumeUsdc via recordTrade), so it is no longer the "V3-only
    // subset" the old comment warned about, and it has complete all-time history
    // instead of the RPC scan's ~70h window. The RPC scan (getAggregateStats)
    // stays as the fallback when the subgraph is unset/behind. insertSnapshot
    // takes a monotonic MAX, so a transiently-lower value can never regress the
    // persisted headline either way.
    let snap = await getGoldskyStats().catch(() => null);
    if (!snap) {
        try {
            snap = await getAggregateStats();
        } catch (err) {
            console.error("[stats-cron] getAggregateStats threw:", err);
            return NextResponse.json(
                { persisted: false, error: "scan-failed" },
                { status: 500 },
            );
        }
    }

    const persisted = await insertSnapshot(snap, "cron");
    if (!persisted) {
        return NextResponse.json(
            { persisted: false, error: "insert-failed" },
            { status: 500 },
        );
    }

    return NextResponse.json({
        persisted: true,
        asOfBlock: snap.asOfBlock.toString(),
        txCount: snap.txCount,
        uniqueWallets: snap.uniqueWallets,
        tokensLaunched:
            snap.tokensLaunched + snap.v4TokensLaunched + snap.v4HookLaunches,
        volumeUsdcMicros: snap.volumeUsdcMicros.toString(),
        truncated: snap.truncated,
    });
}
