-- Audit I10 supplement: three data-correctness fixes the prior
-- migrations did not cover, all rolled into one schema bump so the
-- operator runs a single migration end-to-end rather than three.
--
--   (a) compounder_events.block_at currently defaults to NOW() at
--       insert time, which is the SERVER's wall clock when the cron
--       writes the row, NOT the on-chain block timestamp. Under
--       cron lag (Vercel cold-start, GH Actions queue, RPC latency)
--       the skew is seconds-to-minutes. Charts and "compounded so
--       far" tiles disagree with on-chain receipts.
--
--   (b) compounder_positions.min_fee_micros is BIGINT (max ~9.2e18).
--       The contract column is uint64 (max ~1.8e19). A high-decimals
--       memecoin combined with a large minFee setting can overflow
--       the BIGINT and break the cron's threshold comparison. NUMERIC
--       has no practical ceiling and matches the contract's intent.
--
--   (c) getCompoundedTotalForOwner joined compounder_positions on
--       token_id alone. If an NFT was withdrawn AND re-deposited by a
--       DIFFERENT owner (the NPM transfers between owners freely),
--       the events from the prior life got attributed to the new
--       owner. Tightening the join to (token_id, deposited_at <=
--       block_at < COALESCE(withdrawn_at, infinity)) closes the
--       attribution window so only events that happened DURING the
--       current owner's tenure count toward their total.

-- ---------------------------------------------------------------
-- (a) block_at sourced from receipt block timestamp, not NOW()
-- ---------------------------------------------------------------
-- The default still falls back to NOW() so a missing block_at value
-- (legacy rows, or a row the cron failed to populate fully) does not
-- leave a NULL. New writes from the cron pass the chain timestamp
-- explicitly. block_number is already populated per row, so the
-- backfill path joins against a future on-chain index to fill any
-- gaps deterministically.

-- Add a `chain_block_at` column distinct from `block_at`. We keep
-- `block_at` as the legacy / fallback wall-clock for compatibility
-- with any external tooling still reading it, and `chain_block_at`
-- carries the new chain-authoritative timestamp. The
-- getCompoundedTotalForOwner query below picks COALESCE so the
-- migration is transparently safe for pre-migration rows.
ALTER TABLE compounder_events
    ADD COLUMN IF NOT EXISTS chain_block_at TIMESTAMPTZ;

-- ---------------------------------------------------------------
-- (b) min_fee_micros widened from BIGINT to NUMERIC
-- ---------------------------------------------------------------
ALTER TABLE compounder_positions
    ALTER COLUMN min_fee_micros TYPE NUMERIC(38, 0)
    USING min_fee_micros::NUMERIC(38, 0);

-- ---------------------------------------------------------------
-- (c) Owner-history-aware attribution index
-- ---------------------------------------------------------------
-- Speeds up the new join. Partial because the dominant query path is
-- "active positions" and a full index would cover withdrawn-then-re-
-- deposited history the dashboard never reads.
CREATE INDEX IF NOT EXISTS idx_compounder_events_token_chain_at
    ON compounder_events (token_id, chain_block_at);
