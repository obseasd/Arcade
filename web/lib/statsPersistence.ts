import { getSql, isDbConfigured } from "./db";
import type { StatsSnapshot } from "./stats";

/**
 * Persistence layer for /stats aggregate snapshots.
 *
 * The /stats RPC scan is expensive (cold call fans 600+ eth_getLogs
 * requests at Arc) AND lossy across redeploys (anything beyond MAX_TOTAL_BLOCKS
 * fades out). This module shifts the source of truth to Postgres so the
 * page renders instantly off a hot row and the time-series survives any
 * future contract redeploy.
 *
 * The cron writes; the page reads. When Postgres is not configured the
 * page falls back to the live scan path it has always had — no hard
 * dependency on the DB existing.
 */

/** Row shape returned by getLatest / getHistory. Stays close to
 *  StatsSnapshot so callers can swap the source with one ternary. */
export interface PersistedSnapshot extends StatsSnapshot {
    /** ISO timestamp of the row insert. Distinct from asOfIso which is
     *  when the RPC scan ran — usually equal but a manual replay can
     *  surface the discrepancy. */
    persistedAtIso: string;
    /** Provenance label so dashboards can distinguish cron-driven rows
     *  (canonical) from manual replays or cold-load fallbacks. */
    source: "cron" | "manual" | "fallback";
}

interface RawRow {
    snapshot_at: string;
    as_of_block: string;
    tx_count: number;
    unique_wallets: number;
    tokens_launched: number;
    v4_tokens_launched: number;
    v4_hook_launches: number;
    volume_usdc_micros: string;
    estimated_usdc_gas_micros: string;
    truncated: boolean;
    source: "cron" | "manual" | "fallback";
}

function rowToSnapshot(r: RawRow): PersistedSnapshot {
    // Postgres returns TIMESTAMPTZ as an ISO-ish string in JSON; coerce
    // through Date so we always emit a clean ISO downstream.
    const iso = new Date(r.snapshot_at).toISOString();
    return {
        txCount: r.tx_count,
        uniqueWallets: r.unique_wallets,
        tokensLaunched: r.tokens_launched,
        v4TokensLaunched: r.v4_tokens_launched,
        v4HookLaunches: r.v4_hook_launches,
        // Convert PG NUMERIC (string on the wire to preserve precision)
        // into native bigints for parity with the live-scan path.
        volumeUsdcMicros: BigInt(r.volume_usdc_micros),
        estimatedUsdcGasMicros: BigInt(r.estimated_usdc_gas_micros),
        asOfBlock: BigInt(r.as_of_block),
        asOfIso: iso,
        truncated: r.truncated,
        persistedAtIso: iso,
        source: r.source,
    };
}

/** Returns the most recent persisted snapshot, or null when the DB is
 *  empty or not configured. Used by /stats as the primary read. */
export async function getLatestPersistedSnapshot(): Promise<PersistedSnapshot | null> {
    if (!isDbConfigured()) return null;
    try {
        const sql = getSql();
        const rows = (await sql`
            SELECT
                snapshot_at,
                as_of_block,
                tx_count,
                unique_wallets,
                tokens_launched,
                v4_tokens_launched,
                v4_hook_launches,
                volume_usdc_micros,
                estimated_usdc_gas_micros,
                truncated,
                source
            FROM stats_snapshots
            ORDER BY snapshot_at DESC
            LIMIT 1
        `) as unknown as RawRow[];
        if (rows.length === 0) return null;
        return rowToSnapshot(rows[0]);
    } catch (err) {
        // Most likely cause: migration not run yet on a fresh attach.
        // Log and fall back to the live path so /stats keeps working.
        console.warn("[stats] getLatestPersistedSnapshot failed:", err);
        return null;
    }
}

/** Returns time-ordered snapshots in the given window. Used for the
 *  history chart on /stats. Capped at 2000 rows to keep the response
 *  bounded — a full year of hourly snapshots is ~8760 rows so the cap
 *  forces the caller to either widen the window step or accept
 *  truncation gracefully. */
export async function getSnapshotHistory(
    sinceIso: string,
    limit = 2000,
): Promise<PersistedSnapshot[]> {
    if (!isDbConfigured()) return [];
    try {
        const sql = getSql();
        const cap = Math.max(1, Math.min(limit, 2000));
        const rows = (await sql`
            SELECT
                snapshot_at,
                as_of_block,
                tx_count,
                unique_wallets,
                tokens_launched,
                v4_tokens_launched,
                v4_hook_launches,
                volume_usdc_micros,
                estimated_usdc_gas_micros,
                truncated,
                source
            FROM stats_snapshots
            WHERE snapshot_at >= ${sinceIso}::timestamptz
            ORDER BY snapshot_at ASC
            LIMIT ${cap}
        `) as unknown as RawRow[];
        return rows.map(rowToSnapshot);
    } catch (err) {
        console.warn("[stats] getSnapshotHistory failed:", err);
        return [];
    }
}

/** Insert a row. Returns true on success, false on any failure (caller
 *  decides whether to treat that as fatal; the cron route returns 500
 *  so GitHub Actions can alert). */
export async function insertSnapshot(
    snap: StatsSnapshot,
    source: "cron" | "manual" | "fallback",
): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            INSERT INTO stats_snapshots (
                as_of_block,
                tx_count,
                unique_wallets,
                tokens_launched,
                v4_tokens_launched,
                v4_hook_launches,
                volume_usdc_micros,
                estimated_usdc_gas_micros,
                truncated,
                source
            ) VALUES (
                ${snap.asOfBlock.toString()}::BIGINT,
                ${snap.txCount},
                ${snap.uniqueWallets},
                ${snap.tokensLaunched},
                ${snap.v4TokensLaunched},
                ${snap.v4HookLaunches},
                ${snap.volumeUsdcMicros.toString()}::NUMERIC,
                ${snap.estimatedUsdcGasMicros.toString()}::NUMERIC,
                ${snap.truncated},
                ${source}
            )
        `;
        return true;
    } catch (err) {
        console.error("[stats] insertSnapshot failed:", err);
        return false;
    }
}

/** True when the table exists and has at least one row. Used by the
 *  /api/stats/cron route to decide whether to silently swallow a
 *  "table missing" error (first cron after fresh attach) and try to
 *  create the table on the fly. */
export async function hasAnyPersistedSnapshot(): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        const rows = (await sql`
            SELECT EXISTS (SELECT 1 FROM stats_snapshots LIMIT 1) AS exists
        `) as unknown as { exists: boolean }[];
        return Boolean(rows[0]?.exists);
    } catch {
        return false;
    }
}
