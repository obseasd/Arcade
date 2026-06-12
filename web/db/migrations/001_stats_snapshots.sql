-- Stats persistence: one row per cron snapshot of /stats aggregate.
--
-- Why this exists: without persistence, every contract redeploy resets
-- the /stats page back to whatever the live RPC scan can recover. The
-- predecessor-contracts list inside lib/stats.ts mitigates that for the
-- current snapshot, but cannot retain the time-series history that lets
-- us prove growth to Circle / Arc / partners. This table is the
-- canonical store of "what Arcade looked like at moment T".
--
-- Cardinality: hourly cron + manual triggers. ~8,800 rows / year.
-- Row width ~150 bytes. <2MB / year, fits in Vercel Postgres free tier
-- (256MB) for 100+ years before we need to think about partitioning.
--
-- Numeric columns use NUMERIC(38, 0) instead of BIGINT because USDC
-- amounts are 6-decimal raw and the cumulative volume can exceed 2^63
-- once mainnet ramps. NUMERIC(38, 0) holds up to 10^38 - 1, more than
-- enough for any conceivable on-chain volume.
CREATE TABLE IF NOT EXISTS stats_snapshots (
    id                          BIGSERIAL PRIMARY KEY,
    snapshot_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    as_of_block                 BIGINT NOT NULL,
    tx_count                    INTEGER NOT NULL DEFAULT 0,
    unique_wallets              INTEGER NOT NULL DEFAULT 0,
    tokens_launched             INTEGER NOT NULL DEFAULT 0,
    v4_tokens_launched          INTEGER NOT NULL DEFAULT 0,
    v4_hook_launches            INTEGER NOT NULL DEFAULT 0,
    volume_usdc_micros          NUMERIC(38, 0) NOT NULL DEFAULT 0,
    estimated_usdc_gas_micros   NUMERIC(38, 0) NOT NULL DEFAULT 0,
    truncated                   BOOLEAN NOT NULL DEFAULT FALSE,
    -- 'cron' | 'manual' | 'fallback'. Cron snapshots are the canonical
    -- time-series; manual is a backstop the operator can fire from the
    -- API; fallback marks a snapshot the runtime took on a cold /stats
    -- load when the DB was empty so the page never showed zeros.
    source                      VARCHAR(16) NOT NULL DEFAULT 'cron'
);

-- Latest-snapshot lookup needs the index because the canonical /stats
-- query is ORDER BY snapshot_at DESC LIMIT 1.
CREATE INDEX IF NOT EXISTS idx_stats_snapshots_at
    ON stats_snapshots (snapshot_at DESC);

-- The history-chart query selects a window like
--   WHERE snapshot_at > NOW() - INTERVAL '7 days'
-- which the same DESC index supports via a range scan.
