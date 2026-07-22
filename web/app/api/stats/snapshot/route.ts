import { NextRequest, NextResponse } from "next/server";
import { getAggregateStats, getGoldskyStats, type StatsSnapshot } from "@/lib/stats";
import {
    getLatestPersistedSnapshot,
    insertSnapshot,
} from "@/lib/statsPersistence";
import { rateLimit } from "@/lib/apiGuard";

/**
 * Public JSON read of Arcade activity metrics.
 *
 * Read order:
 *   1. Latest persisted snapshot from Postgres (instant, no RPC).
 *   2. Live RPC scan as a fallback when the DB is empty or unreachable.
 *      The fallback snapshot is opportunistically written back to the DB
 *      tagged `source='fallback'` so a freshly attached database
 *      bootstraps without waiting for the next hourly cron.
 *
 * Revalidation: 5 minutes so even the DB-read path stays cached at the
 * edge. The route MUST stay rate-limited because the fallback branch
 * is unbounded RPC, and a sustained cache-busting query (`?_=...`)
 * would otherwise force a fresh scan on every hit.
 *
 * Consumers:
 *   - /stats page (server component)
 *   - footer "USDC gas paid via Arcade: $X" counter (client)
 *   - /api/og/stats route (OG image render)
 *   - external dashboards (Dune mirror, ArcLens, partners)
 */
export const revalidate = 300;

// Audit 2026-06-11 API-5 + v2 V2-F-04: tight per-IP rate limit so a
// cache-busting query (`?_=...`) cannot defeat the 5-minute ISR cache
// and force a fresh getAggregateStats RPC scan on every hit. 5 req/min
// is well above honest polling (footer counter polls at most once every
// 5 min) but well below the threshold where a sustained burst could
// flood Arc RPC.
export async function GET(req: NextRequest) {
    const rl = rateLimit(req, "stats-snapshot", 5, 60_000);
    if (rl) return rl;

    const persisted = await getLatestPersistedSnapshot();
    if (persisted) {
        return NextResponse.json(serialise(persisted, "db"));
    }

    // Cold path: DB empty or not configured. Prefer the Goldsky subgraph (ONE
    // GraphQL query, complete history) over the 500k-block x ~50-contract RPC
    // scan, which is now only the last resort when the subgraph is unset/behind.
    // Write whichever we got back so the next read hits the fast DB path.
    const goldsky = await getGoldskyStats().catch(() => null);
    const snapshot = goldsky ?? (await getAggregateStats());
    void insertSnapshot(snapshot, "fallback").catch(() => {
        // Already logged inside insertSnapshot; swallow here so a
        // misconfigured DB does not bubble up to the caller.
    });
    return NextResponse.json(serialise(snapshot, goldsky ? "subgraph" : "live"));
}

function serialise(snap: StatsSnapshot, source: "db" | "live" | "subgraph") {
    return {
        ...snap,
        asOfBlock: snap.asOfBlock.toString(),
        volumeUsdcMicros: snap.volumeUsdcMicros.toString(),
        estimatedUsdcGasMicros: snap.estimatedUsdcGasMicros.toString(),
        source,
    };
}
