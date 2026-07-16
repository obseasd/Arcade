-- Per-CCTP-route bridged-volume breakdown (stats M3).
--
-- keeper_bridge_intents already records the CCTP source domain (the "route")
-- for every bridge-and-buy, but not HOW MUCH USDC was bridged, so the /stats
-- page can count routes but not sum dollars per route. The frontend knows the
-- burn amount at depositForBurn time (it just built that tx), so /api/bridge/
-- intent now records it here. Nullable + IF NOT EXISTS so applying this on a
-- populated table is a no-op backfill (old rows keep NULL and are excluded
-- from the SUM, which is correct -- we never invented an amount for them).
ALTER TABLE keeper_bridge_intents
    ADD COLUMN IF NOT EXISTS usdc_amount BIGINT;

-- The stats breakdown groups by src_domain over settled + in-flight intents.
-- A partial-ish index on src_domain keeps that GROUP BY cheap as the table
-- grows (the breakdown reads all non-failed rows, so we do not filter here).
CREATE INDEX IF NOT EXISTS idx_keeper_bridge_route
    ON keeper_bridge_intents (src_domain);
