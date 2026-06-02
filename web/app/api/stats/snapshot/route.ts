import { NextResponse } from "next/server";
import { getAggregateStats } from "@/lib/stats";

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

export async function GET() {
    const snapshot = await getAggregateStats();
    // bigint cannot serialize directly; stringify for transport.
    return NextResponse.json({
        ...snapshot,
        asOfBlock: snapshot.asOfBlock.toString(),
        estimatedUsdcGasMicros: snapshot.estimatedUsdcGasMicros.toString(),
    });
}
