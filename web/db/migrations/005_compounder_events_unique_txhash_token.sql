-- Batch-compound support.
--
-- The keeper cron now bundles up to N positions' compound()/pushFees()
-- calls into ONE Multicall3 transaction, so N event rows legitimately
-- share the same tx_hash. The 003 partial UNIQUE(tx_hash) index would
-- reject N-1 of those inserts (ON CONFLICT heal-path), silently dropping
-- per-position fee rows and re-breaking the "Total earned" headline —
-- exactly the class of bug 004 fixed.
--
-- Fix: widen the uniqueness key to (tx_hash, token_id). This still dedupes
-- a retried insert for the same position in the same tx, but allows one
-- row per position per batch tx. It is BACKWARD-COMPATIBLE with the
-- pre-batch cron (each 1-tx-per-position row is trivially unique under the
-- wider key), so this migration is safe to apply BEFORE the cron change
-- ships. Apply this on the database first, then deploy the batched cron.

-- 1. Drop any pre-existing (tx_hash, token_id) duplicates, keeping the
--    lowest id (oldest) per pair, so the new unique index can be built.
DELETE FROM compounder_events e1
 WHERE e1.tx_hash IS NOT NULL
   AND e1.id <> (
       SELECT MIN(e2.id)
         FROM compounder_events e2
        WHERE e2.tx_hash = e1.tx_hash
          AND e2.token_id = e1.token_id
   );

-- 2. Replace the (tx_hash)-only unique index with (tx_hash, token_id).
DROP INDEX IF EXISTS uq_compounder_events_tx_hash;

CREATE UNIQUE INDEX IF NOT EXISTS uq_compounder_events_tx_hash_token
    ON compounder_events (tx_hash, token_id)
    WHERE tx_hash IS NOT NULL;
