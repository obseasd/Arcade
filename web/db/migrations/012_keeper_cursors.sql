-- Generic keeper scan cursors (last-processed block per named scan). Used by the
-- fee-protocol sync leg to scan V3 PoolCreated events forward from where it left
-- off, instead of re-scanning a fixed window every tick. Re-runnable.
CREATE TABLE IF NOT EXISTS keeper_cursors (
    name TEXT PRIMARY KEY,
    block BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
