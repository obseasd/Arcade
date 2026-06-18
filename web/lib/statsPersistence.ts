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
        txCount: r.tx_count ?? 0,
        uniqueWallets: r.unique_wallets ?? 0,
        tokensLaunched: r.tokens_launched ?? 0,
        v4TokensLaunched: r.v4_tokens_launched ?? 0,
        v4HookLaunches: r.v4_hook_launches ?? 0,
        // Convert PG NUMERIC (string on the wire to preserve precision)
        // into native bigints for parity with the live-scan path.
        // The FILTERed MAX in getLatestPersistedSnapshot returns NULL
        // when every row in the table fails the sanity predicate (e.g.
        // a fresh deploy whose only persisted row is a pre-fix inflated
        // one); guard with 0n so the snapshot serialiser doesn't throw
        // on BigInt(null).
        volumeUsdcMicros: r.volume_usdc_micros
            ? BigInt(r.volume_usdc_micros)
            : 0n,
        estimatedUsdcGasMicros: r.estimated_usdc_gas_micros
            ? BigInt(r.estimated_usdc_gas_micros)
            : 0n,
        asOfBlock: BigInt(r.as_of_block),
        asOfIso: iso,
        truncated: r.truncated,
        persistedAtIso: iso,
        source: r.source,
    };
}

/**
 * Audit 2026-06-18 H-05: the MAX-across-all-history strategy used to
 * lock the public counters to ANY single corrupted row forever. The
 * team already hit this once on `volume_usdc_micros` (a corrupted row
 * landed 2.6e25 micros = $26 quadrillion in the table — preserved as
 * a comment below) but the FILTER clause was applied to ONLY the
 * volume column. The other six monotonic columns (tx_count,
 * unique_wallets, tokens_launched, v4_tokens_launched, v4_hook_launches,
 * estimated_usdc_gas_micros) were unfiltered — a single bad scan could
 * stamp an impossible value into any of them and the dashboard would
 * display that forever with no recovery path short of a manual DELETE.
 *
 * Mitigation: cap the MAX to the most recent N hours of cron-tagged
 * snapshots. Transient anomalies age out automatically. The window is
 * generous (default 168h = 7 days, covers a week of cron outage) so the
 * headline stays cumulative across normal operations but a single bad
 * row stops affecting the dashboard ~7 days later.
 */
const PERSISTED_MAX_WINDOW_HOURS = 168;

/** Returns the most recent persisted snapshot, or null when the DB is
 *  empty or not configured. Used by /stats as the primary read. */
export async function getLatestPersistedSnapshot(): Promise<PersistedSnapshot | null> {
    if (!isDbConfigured()) return null;
    try {
        const sql = getSql();
        // The cron scans a fixed 500k-block window, so an individual
        // snapshot's counts only see events that landed in the last
        // ~3 days. Tokens launched 4 days ago, txs from a busy week
        // ago — all of them roll out of the window and disappear from
        // the next snapshot's "tokens_launched" / "tx_count" /
        // "volume" values. The dashboard previously surfaced the most
        // recent row verbatim, which made the headline counters look
        // like they were *shrinking* over time even though every
        // metric is monotonically growing on chain.
        //
        // Take the MAX of every monotonic column across the cron-tagged
        // rows of the last PERSISTED_MAX_WINDOW_HOURS (the table is a
        // time-series of append-only rows so the MAX over that window
        // is the cumulative truth at the time of the latest snapshot,
        // ignoring older rows that may have been written by buggy
        // pre-fix scans). Pair it with the latest row's snapshot_at /
        // as_of_block / truncated / source for the freshness signal.
        const rows = (await sql`
            WITH latest AS (
                SELECT snapshot_at, as_of_block, truncated, source
                FROM stats_snapshots
                ORDER BY snapshot_at DESC
                LIMIT 1
            ),
            recent AS (
                SELECT *
                FROM stats_snapshots
                WHERE snapshot_at >= NOW() - (${PERSISTED_MAX_WINDOW_HOURS}::text || ' hours')::interval
                  AND source = 'cron'
            )
            SELECT
                latest.snapshot_at,
                latest.as_of_block,
                MAX(r.tx_count)                  AS tx_count,
                MAX(r.unique_wallets)            AS unique_wallets,
                MAX(r.tokens_launched)           AS tokens_launched,
                MAX(r.v4_tokens_launched)        AS v4_tokens_launched,
                MAX(r.v4_hook_launches)          AS v4_hook_launches,
                -- Pre-fix snapshots (before the decodeEventLog + 10M-USDC
                -- sanity ceiling shipped in 7f7716b) wrote inflated
                -- volume figures up to 2.6e25 micros = $26 quadrillion.
                -- The 7-day MAX window plus the original < 1e15
                -- (less-than-$1B) FILTER keep the headline clean even
                -- if a fresh bug ever lands an inflated row inside the
                -- window.
                MAX(r.volume_usdc_micros)
                    FILTER (WHERE r.volume_usdc_micros < 1000000000000000)
                                                  AS volume_usdc_micros,
                MAX(r.estimated_usdc_gas_micros) AS estimated_usdc_gas_micros,
                latest.truncated,
                latest.source
            FROM recent r
            CROSS JOIN latest
            GROUP BY latest.snapshot_at, latest.as_of_block, latest.truncated, latest.source
        `) as unknown as RawRow[];
        if (rows.length === 0) {
            // Fallback: no cron-tagged rows in the recent window. The
            // table may still have a bootstrap fallback row; surface
            // the latest row verbatim so the page never collapses to
            // zeros when the cron is paused or freshly attached.
            const latest = (await sql`
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
            if (latest.length === 0) return null;
            return rowToSnapshot(latest[0]);
        }
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

/**
 * Audit 2026-06-18 M-02: idempotency guard against concurrent cron
 * runs. Returns the ISO timestamp of the most recent row, or null when
 * the table is empty. The cron route checks this BEFORE running the
 * expensive RPC scan: if the last row is younger than the dedup window
 * we skip the scan entirely instead of stamping a near-duplicate row.
 *
 * Honest about source: only cron-tagged rows count toward the dedup
 * window. A manual replay (source='manual') or fallback row
 * (source='fallback') does not block the next cron run.
 */
export async function lastCronSnapshotIso(): Promise<string | null> {
    if (!isDbConfigured()) return null;
    try {
        const sql = getSql();
        const rows = (await sql`
            SELECT snapshot_at
            FROM stats_snapshots
            WHERE source = 'cron'
            ORDER BY snapshot_at DESC
            LIMIT 1
        `) as unknown as { snapshot_at: string }[];
        if (rows.length === 0) return null;
        return new Date(rows[0].snapshot_at).toISOString();
    } catch (err) {
        console.warn("[stats] lastCronSnapshotIso failed:", err);
        return null;
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
