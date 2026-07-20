import { NextRequest, NextResponse } from "next/server";
import { getSql, isDbConfigured } from "@/lib/db";

/**
 * Idempotent migration runner for the tweet-to-launch schema (the
 * `twitter_launches` table + its per-user index). Mirrors /api/referral/migrate
 * and /api/compounder/migrate: this repo has no automatic migration step, so the
 * DDL that lived only as a comment in twitterLaunchPersistence.ts did NOTHING
 * until applied by hand. Against a DB with no `twitter_launches` table, the cron
 * throws on its first isTweetProcessed() query and no launch ever relays.
 *
 * Every statement is IF NOT EXISTS, so this is a no-op on an already-migrated DB
 * and safe to run twice.
 *
 * Auth: the tweet-launch cron secret, falling back to the shared keeper/
 * compounder secrets (same precedence the cron itself uses).
 *
 * Usage:
 *   curl -X POST "https://.../api/twitter-launch/migrate" \
 *     -H "Authorization: Bearer <TWEET_LAUNCH_CRON_SECRET>"
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
    const secret =
        process.env.TWEET_LAUNCH_CRON_SECRET ??
        process.env.KEEPER_CRON_SECRET ??
        process.env.COMPOUNDER_CRON_SECRET;
    if (!secret) {
        return NextResponse.json(
            { error: "no cron secret configured (TWEET_LAUNCH_CRON_SECRET / KEEPER_CRON_SECRET / COMPOUNDER_CRON_SECRET)" },
            { status: 500 },
        );
    }
    const auth = req.headers.get("authorization");
    const expected = `Bearer ${secret}`;
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

    // One row per processed launch tweet, keyed by tweet id (idempotency) and
    // bound to the author's NUMERIC user-id (the canonical fee-attribution key;
    // the @handle is display metadata only).
    await step("twitter_launches_table", async () =>
        sql`
            CREATE TABLE IF NOT EXISTS twitter_launches (
                tweet_id     TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL,
                handle       TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'pending',
                reason       TEXT,
                token        TEXT,
                pool_id      TEXT,
                tx_hash      TEXT,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `,
    );
    await step("twitter_launches_user_id_idx", async () =>
        sql`
            CREATE INDEX IF NOT EXISTS twitter_launches_user_id_idx
                ON twitter_launches (user_id, created_at)
        `,
    );

    // --- v2: reply-to-launch (50/50) + since_id polling state ---------------
    // The original poster of a replied-to tweet gets slot 1 of the launch's
    // escrow (the launcher keeps slot 0). op_* records who, pool_id ties it to
    // the on-chain launch, slot1_credited_usdc tracks how much has already been
    // swept from the operator into the escrow so we never double-credit.
    await step("v2_is_reply", async () =>
        sql`ALTER TABLE twitter_launches ADD COLUMN IF NOT EXISTS is_reply BOOLEAN NOT NULL DEFAULT false`,
    );
    await step("v2_op_user_id", async () =>
        sql`ALTER TABLE twitter_launches ADD COLUMN IF NOT EXISTS op_user_id TEXT`,
    );
    await step("v2_op_handle", async () =>
        sql`ALTER TABLE twitter_launches ADD COLUMN IF NOT EXISTS op_handle TEXT`,
    );
    await step("v2_slot1_credited", async () =>
        sql`ALTER TABLE twitter_launches ADD COLUMN IF NOT EXISTS slot1_credited_usdc NUMERIC NOT NULL DEFAULT 0`,
    );
    // Key/value state so each poll only fetches tweets newer than the last one
    // seen (X pay-per-use bills per post returned; since_id keeps that minimal).
    await step("v2_state_table", async () =>
        sql`
            CREATE TABLE IF NOT EXISTS twitter_launch_state (
                key   TEXT PRIMARY KEY,
                value TEXT
            )
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
