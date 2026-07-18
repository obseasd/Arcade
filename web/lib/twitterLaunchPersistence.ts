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
}): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        INSERT INTO twitter_launches (tweet_id, user_id, handle, status, reason, token, pool_id, tx_hash)
        VALUES (${input.tweetId}, ${input.userId}, ${input.handle}, ${input.status},
                ${input.reason ?? null}, ${input.token ?? null}, ${input.poolId ?? null}, ${input.txHash ?? null})
        ON CONFLICT (tweet_id) DO UPDATE SET
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            token = COALESCE(EXCLUDED.token, twitter_launches.token),
            pool_id = COALESCE(EXCLUDED.pool_id, twitter_launches.pool_id),
            tx_hash = COALESCE(EXCLUDED.tx_hash, twitter_launches.tx_hash)
    `;
}
