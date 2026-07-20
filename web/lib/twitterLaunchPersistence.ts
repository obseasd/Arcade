import { getSql, isDbConfigured } from "@/lib/db";

/**
 * Persistence for tweet-to-launch. One row per processed launch tweet, keyed by
 * the tweet id (idempotency) and bound to the author's NUMERIC user-id (the
 * canonical fee-attribution key; the @handle is display metadata only).
 *
 * Migration (run once on Neon):
 *   CREATE TABLE IF NOT EXISTS twitter_launches (
 *     tweet_id     TEXT PRIMARY KEY,
 *     user_id      TEXT NOT NULL,
 *     handle       TEXT NOT NULL,
 *     status       TEXT NOT NULL DEFAULT 'pending', -- pending|launched|rejected|failed
 *     reason       TEXT,
 *     token        TEXT,
 *     pool_id      TEXT,
 *     tx_hash      TEXT,
 *     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX IF NOT EXISTS twitter_launches_user_id_idx ON twitter_launches (user_id, created_at);
 */

export type LaunchStatus = "pending" | "launched" | "rejected" | "failed";

/** True if this tweet was already processed (any status) — idempotency guard. */
export async function isTweetProcessed(tweetId: string): Promise<boolean> {
    if (!isDbConfigured()) return false;
    const sql = getSql();
    const rows = (await sql`SELECT 1 FROM twitter_launches WHERE tweet_id = ${tweetId} LIMIT 1`) as unknown[];
    return rows.length > 0;
}

/** Count how many tokens a user-id has launched since `sinceIso` (rate-limit). */
export async function userLaunchCountSince(userId: string, sinceIso: string): Promise<number> {
    if (!isDbConfigured()) return 0;
    const sql = getSql();
    const rows = (await sql`
        SELECT count(*)::int AS n FROM twitter_launches
        WHERE user_id = ${userId} AND status = 'launched' AND created_at >= ${sinceIso}
    `) as { n: number }[];
    return rows[0]?.n ?? 0;
}

/** Upsert a processed tweet row. */
export async function recordLaunchTweet(input: {
    tweetId: string;
    userId: string;
    handle: string;
    status: LaunchStatus;
    reason?: string;
    token?: string;
    poolId?: string;
    txHash?: string;
    /** Reply-to-launch: the original poster gets 50% (escrow slot 1). */
    isReply?: boolean;
    opUserId?: string;
    opHandle?: string;
}): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        INSERT INTO twitter_launches
            (tweet_id, user_id, handle, status, reason, token, pool_id, tx_hash, is_reply, op_user_id, op_handle)
        VALUES (${input.tweetId}, ${input.userId}, ${input.handle}, ${input.status},
                ${input.reason ?? null}, ${input.token ?? null}, ${input.poolId ?? null}, ${input.txHash ?? null},
                ${input.isReply ?? false}, ${input.opUserId ?? null}, ${input.opHandle ?? null})
        ON CONFLICT (tweet_id) DO UPDATE SET
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            token = COALESCE(EXCLUDED.token, twitter_launches.token),
            pool_id = COALESCE(EXCLUDED.pool_id, twitter_launches.pool_id),
            tx_hash = COALESCE(EXCLUDED.tx_hash, twitter_launches.tx_hash),
            is_reply = EXCLUDED.is_reply,
            op_user_id = COALESCE(EXCLUDED.op_user_id, twitter_launches.op_user_id),
            op_handle = COALESCE(EXCLUDED.op_handle, twitter_launches.op_handle)
    `;
}

/** Last processed tweet id, for the X search `since_id` (min posts returned). */
export async function getSinceId(): Promise<string | null> {
    if (!isDbConfigured()) return null;
    const sql = getSql();
    const rows = (await sql`SELECT value FROM twitter_launch_state WHERE key = 'since_id' LIMIT 1`) as {
        value: string | null;
    }[];
    return rows[0]?.value ?? null;
}

/** Advance the `since_id` cursor to the newest tweet id seen this run. */
export async function setSinceId(tweetId: string): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        INSERT INTO twitter_launch_state (key, value) VALUES ('since_id', ${tweetId})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
}

/** A reply-launch whose original poster (slot 1) may be owed escrow credit.
 *  Used by the on-demand reconciliation at claim time. */
export interface ReplyLaunchRow {
    poolId: string;
    opUserId: string;
    opHandle: string;
    slot1CreditedUsdc: string;
}

/** Look up the reply-launch (slot-1) record for a pool, or null. */
export async function getReplyLaunchByPool(poolId: string): Promise<ReplyLaunchRow | null> {
    if (!isDbConfigured()) return null;
    const sql = getSql();
    const rows = (await sql`
        SELECT pool_id, op_user_id, op_handle, slot1_credited_usdc
        FROM twitter_launches
        WHERE pool_id = ${poolId} AND is_reply = true AND op_user_id IS NOT NULL
        LIMIT 1
    `) as { pool_id: string; op_user_id: string; op_handle: string; slot1_credited_usdc: string }[];
    const r = rows[0];
    if (!r) return null;
    return { poolId: r.pool_id, opUserId: r.op_user_id, opHandle: r.op_handle, slot1CreditedUsdc: r.slot1_credited_usdc };
}

/** Record that `totalCreditedMicros` (cumulative raw USDC micros) has now been
 *  swept from the operator into the escrow slot 1 for this pool. */
export async function setSlot1Credited(poolId: string, totalCreditedMicros: string): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`UPDATE twitter_launches SET slot1_credited_usdc = ${totalCreditedMicros} WHERE pool_id = ${poolId}`;
}

/** Every launched reply-launch pool (for the safety-net batch reconciliation). */
export async function listReplyLaunchPools(): Promise<string[]> {
    if (!isDbConfigured()) return [];
    const sql = getSql();
    const rows = (await sql`
        SELECT pool_id FROM twitter_launches
        WHERE is_reply = true AND status = 'launched' AND pool_id IS NOT NULL AND op_user_id IS NOT NULL
    `) as { pool_id: string }[];
    return rows.map((r) => r.pool_id);
}
