import { NextRequest, NextResponse } from "next/server";
import { getSql, isDbConfigured } from "@/lib/db";

/**
 * Idempotent migration runner for the compounder schema.
 *
 * Applies migrations 003 (UNIQUE(tx_hash) partial index) and 004
 * (chain_block_at column + min_fee_micros widen) directly via the
 * serverless Neon driver. Both migrations are written with IF NOT
 * EXISTS / IF EXISTS guards so re-running them is a no-op on a fully
 * migrated DB.
 *
 * Why this exists: the original migration runner was a separate
 * GitHub Actions step that never wired into the Vercel deploy. The
 * /api/compounder/backfill-tx endpoint surfaced the missing UNIQUE
 * constraint on 2026-06-16 with the "there is no unique or exclusion
 * constraint matching the ON CONFLICT specification" error. Rather
 * than file an ops ticket for psql access, we expose a manual
 * trigger here.
 *
 * Auth: same Bearer secret as the cron / reconcile routes.
 *
 * Usage:
 *   curl -X POST "https://.../api/compounder/migrate" \
 *     -H "Authorization: Bearer <COMPOUNDER_CRON_SECRET>"
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface StepResult {
    name: string;
    ok: boolean;
    error?: string;
    rowsAffected?: number;
}

export async function POST(req: NextRequest) {
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

    if (!isDbConfigured()) {
        return NextResponse.json(
            { error: "Postgres not configured" },
            { status: 500 },
        );
    }

    const sql = getSql();
    const results: StepResult[] = [];

    async function step(
        name: string,
        run: () => Promise<unknown>,
    ): Promise<void> {
        try {
            const out = await run();
            const rowsAffected = Array.isArray(out)
                ? (out as unknown[]).length
                : undefined;
            results.push({ name, ok: true, rowsAffected });
        } catch (err) {
            results.push({
                name,
                ok: false,
                error:
                    (err as { message?: string })?.message ?? String(err),
            });
        }
    }

    // Migration 003 step 1: dedup any duplicate tx_hash rows that
    // accumulated from cron retries before the UNIQUE constraint
    // existed. Pick the lowest id per tx_hash as canonical.
    await step("003_dedup_duplicate_tx_hash", async () =>
        sql`
            DELETE FROM compounder_events e1
             WHERE e1.tx_hash IS NOT NULL
               AND e1.id <> (
                    SELECT MIN(e2.id)
                      FROM compounder_events e2
                     WHERE e2.tx_hash = e1.tx_hash
               )
        `,
    );

    // Migration 003 step 2: partial UNIQUE index on tx_hash. Required
    // by insertEvent's ON CONFLICT (tx_hash) DO UPDATE clause.
    await step("003_unique_tx_hash_index", async () =>
        sql`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_compounder_events_tx_hash
                ON compounder_events (tx_hash)
                WHERE tx_hash IS NOT NULL
        `,
    );

    // Migration 004 step 1: chain_block_at column for chain-authoritative
    // timestamps from the receipt's block.
    await step("004_add_chain_block_at_column", async () =>
        sql`
            ALTER TABLE compounder_events
                ADD COLUMN IF NOT EXISTS chain_block_at TIMESTAMPTZ
        `,
    );

    // Migration 004 step 2: widen min_fee_micros from BIGINT to
    // NUMERIC(38,0) so high-decimals memecoins + large thresholds
    // cannot overflow.
    await step("004_widen_min_fee_micros", async () =>
        sql`
            ALTER TABLE compounder_positions
                ALTER COLUMN min_fee_micros TYPE NUMERIC(38, 0)
                USING min_fee_micros::NUMERIC(38, 0)
        `,
    );

    // Migration 004 step 3: index for owner-history-aware
    // attribution queries (chain_block_at-based time window).
    await step("004_chain_at_index", async () =>
        sql`
            CREATE INDEX IF NOT EXISTS idx_compounder_events_token_chain_at
                ON compounder_events (token_id, chain_block_at)
        `,
    );

    const failed = results.filter((r) => !r.ok);
    return NextResponse.json(
        {
            ok: failed.length === 0,
            stepsRun: results.length,
            stepsFailed: failed.length,
            results,
        },
        { status: failed.length === 0 ? 200 : 500 },
    );
}
