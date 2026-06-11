import { NextRequest, NextResponse } from "next/server";
import { getAggregateStats } from "@/lib/stats";
import { rateLimit } from "@/lib/apiGuard";

/**
 * Cached JSON snapshot of Arcade activity metrics. Revalidates every 5
 * minutes (300s) so the underlying RPC scan does not run on every request.
 * Free-tier compatible: no external indexer, no Vercel KV, no Postgres.
 *
 * Consumers:
 *   - /stats page (server component)
 *   - footer "USDC gas paid via Arcade: $X" counter (client component)
 *   - /api/og/stats route (OG image render)
 *   - external tooling (Dune-style replication, ArcLens, partner dashboards)
 */
export const revalidate = 300;

// Audit 2026-06-11 API-5: per-IP rate limit so a cache-busting query
// (`?_=...`) can't defeat the 5-minute ISR cache and force a fresh
// getAggregateStats RPC scan on every hit. 30 req/min/IP is well above
// honest polling (footer counter polls once every 5 min) but well below
// the threshold where a sustained burst would flood Arc RPC.
export async function GET(req: NextRequest) {
    const rl = rateLimit(req, "stats-snapshot", 30, 60_000);
    if (rl) return rl;
    const snapshot = await getAggregateStats();
    // bigint cannot serialize directly; stringify for transport.
    return NextResponse.json({
        ...snapshot,
        asOfBlock: snapshot.asOfBlock.toString(),
        estimatedUsdcGasMicros: snapshot.estimatedUsdcGasMicros.toString(),
    });
}
