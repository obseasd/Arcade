import { NextRequest, NextResponse } from "next/server";
import { getSql, isDbConfigured } from "@/lib/db";

/**
 * Idempotent migration runner for the referral schema (006 -> 009).
 *
 * WHY THIS EXISTS. This repo has no automatic migration step: the original
 * runner was a GitHub Action that never wired into the Vercel deploy (see the
 * same note on /api/compounder/migrate, which was added for exactly this reason
 * after a missing UNIQUE constraint surfaced in production). So a migration
 * lands in db/migrations/ and does NOTHING until an operator applies it by hand.
 *
 * That is a live deploy-order landmine for referrals. `registerReferral` writes
 * `verified` / `verified_at` and `getReferralStats` SELECTs `r.verified` -- all
 * three are 009 columns. Against a DB still on 008, every one of those queries
 * throws `column "verified" does not exist`, which means /api/referral/register
 * 500s on every call and the dashboard renders empty. The code shipped ahead of
 * its schema, so this endpoint is the thing that makes the code runnable.
 *
 * Every statement is IF NOT EXISTS, so running this on a fully-migrated DB is a
 * no-op and running it twice is safe. Steps are independent: one failure is
 * reported without aborting the rest, and the response says exactly which.
 *
 * Auth: same Bearer secret as the cron / reconcile / compounder-migrate routes.
 *
 * Usage:
 *   curl -X POST "https://.../api/referral/migrate" \
 *     -H "Authorization: Bearer <COMPOUNDER_CRON_SECRET>"
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface StepResult {
    name: string;
    ok: boolean;
    error?: string;
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
    // Length check first so the comparison below is over equal-length strings.
    if (!auth || auth.length !== expected.length || auth !== expected) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isDbConfigured()) {
        return NextResponse.json({ error: "Postgres not configured" }, { status: 500 });
    }

    const sql = getSql();
    const results: StepResult[] = [];

    async function step(name: string, run: () => Promise<unknown>): Promise<void> {
        try {
            await run();
            results.push({ name, ok: true });
        } catch (err) {
            results.push({
                name,
                ok: false,
                error: (err as { message?: string })?.message ?? String(err),
            });
        }
    }

    // --- 006: attribution + accrual -------------------------------------
    await step("006_referrals_table", async () =>
        sql`
            CREATE TABLE IF NOT EXISTS referrals (
                referred_address  TEXT PRIMARY KEY,
                referrer_address  TEXT NOT NULL,
                created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT referrals_no_self CHECK (referred_address <> referrer_address)
            )
        `,
    );
    await step("006_referrals_referrer_index", async () =>
        sql`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_address)`,
    );
    await step("006_referral_activity_table", async () =>
        sql`
            CREATE TABLE IF NOT EXISTS referral_activity (
                referred_address   TEXT PRIMARY KEY
                    REFERENCES referrals (referred_address) ON DELETE CASCADE,
                volume_usd_micros  BIGINT  NOT NULL DEFAULT 0,
                tx_count           INTEGER NOT NULL DEFAULT 0,
                earned_usd_micros  BIGINT  NOT NULL DEFAULT 0,
                updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `,
    );

    // --- 007: payout ledger ---------------------------------------------
    await step("007_referral_claims_table", async () =>
        sql`
            CREATE TABLE IF NOT EXISTS referral_claims (
                id                BIGSERIAL PRIMARY KEY,
                referrer_address  TEXT   NOT NULL,
                amount_usd_micros BIGINT NOT NULL CHECK (amount_usd_micros > 0),
                tx_hash           TEXT,
                status            TEXT   NOT NULL DEFAULT 'paid',
                created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `,
    );
    await step("007_referral_claims_referrer_index", async () =>
        sql`
            CREATE INDEX IF NOT EXISTS idx_referral_claims_referrer
                ON referral_claims (referrer_address)
        `,
    );

    // --- 008: payout idempotency ----------------------------------------
    await step("008_one_pending_claim_per_referrer", async () =>
        sql`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_claims_one_pending
                ON referral_claims (referrer_address)
                WHERE status = 'pending'
        `,
    );
    await step("008_unique_settlement_tx", async () =>
        sql`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_claims_tx
                ON referral_claims (tx_hash)
                WHERE tx_hash IS NOT NULL
        `,
    );

    // --- 009: the verified tier -----------------------------------------
    // DEFAULT false is deliberate and load-bearing: every pre-existing row was
    // written by the unauthenticated endpoint, so grandfathering them in as
    // proven would hand the land-grab exactly what the column exists to deny.
    await step("009_add_verified_column", async () =>
        sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false`,
    );
    await step("009_add_verified_at_column", async () =>
        sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`,
    );
    await step("009_verified_index", async () =>
        sql`
            CREATE INDEX IF NOT EXISTS idx_referrals_referrer_verified
                ON referrals (referrer_address)
                WHERE verified
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
