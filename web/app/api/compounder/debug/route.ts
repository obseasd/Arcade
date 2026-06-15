import { NextRequest, NextResponse } from "next/server";
import { getSql, isDbConfigured } from "@/lib/db";

/**
 * Diagnostic-only endpoint for tracing the "Total earned $0 despite
 * triggered compound" symptom. Returns the position row + the last
 * few events for a tokenId so we can see exactly what landed in the
 * DB versus what the cron decoded off the receipt.
 *
 * Auth: same Bearer secret as the cron / reconcile routes. NOT a
 * permanent feature — strip once the bug is closed.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const secret = process.env.COMPOUNDER_CRON_SECRET;
    if (!secret) {
        return NextResponse.json(
            { error: "COMPOUNDER_CRON_SECRET not configured" },
            { status: 500 },
        );
    }
    const auth = req.headers.get("authorization");
    const expected = `Bearer ${secret}`;
    if (!auth || auth.length !== expected.length || auth !== expected) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const tokenId = req.nextUrl.searchParams.get("tokenId");

    if (!isDbConfigured()) {
        return NextResponse.json(
            { error: "Postgres not configured" },
            { status: 200 },
        );
    }

    const sql = getSql();

    const positionRows = tokenId && /^\d+$/.test(tokenId)
        ? ((await sql`
            SELECT
                token_id::text       AS token_id,
                owner_address,
                mode,
                min_fee_micros::text AS min_fee_micros,
                max_slippage_bps,
                deposited_at,
                withdrawn_at,
                last_action_at
            FROM compounder_positions
            WHERE token_id = ${tokenId}::BIGINT
        `) as unknown as Array<Record<string, unknown>>)
        : [];

    const eventRows = tokenId && /^\d+$/.test(tokenId)
        ? ((await sql`
            SELECT
                id,
                token_id::text         AS token_id,
                event_type,
                amount0::text          AS amount0,
                amount1::text          AS amount1,
                protocol_fee0::text    AS protocol_fee0,
                protocol_fee1::text    AS protocol_fee1,
                usd_value_micros::text AS usd_value_micros,
                tx_hash,
                block_number::text     AS block_number,
                chain_block_at,
                block_at
            FROM compounder_events
            WHERE token_id = ${tokenId}::BIGINT
            ORDER BY id DESC
            LIMIT 10
        `) as unknown as Array<Record<string, unknown>>)
        : [];

    // Unfiltered table-wide view so we can spot rows landing on the
    // wrong tokenId or duplicated under a different key.
    const allEvents = (await sql`
        SELECT
            id,
            token_id::text         AS token_id,
            event_type,
            amount0::text          AS amount0,
            amount1::text          AS amount1,
            tx_hash,
            block_number::text     AS block_number,
            chain_block_at,
            block_at
        FROM compounder_events
        ORDER BY id DESC
        LIMIT 20
    `) as unknown as Array<Record<string, unknown>>;

    return NextResponse.json({
        tokenId,
        position: positionRows[0] ?? null,
        events: eventRows,
        eventCount: eventRows.length,
        allEventsRecent: allEvents,
    });
}
