-- Audit I10 fix: enforce UNIQUE(tx_hash) on compounder_events so a
-- cron retry that lands after the network already mined the original
-- tx cannot double-insert and inflate the "Total claimed" headline.
-- Previous schema had no constraint here; combined with the GitHub
-- Actions workflow's --retry 2 --retry-delay 5 (three POSTs in 15s),
-- a transient 504 between the API and the cron POSTer is enough to
-- write the same tx twice with two different ids and double the
-- usd_value_micros sum that getTotalClaimedByTokenForOwner reports.
--
-- Constraint is partial because some event types (PositionDeposited,
-- ModeChanged, etc.) currently emit with tx_hash NULL in the cron's
-- insertEvent path, and a NOT NULL + UNIQUE pair would refuse the
-- valid history rows.

-- Drop any existing duplicates BEFORE the constraint can land. Pick
-- the lowest id per tx_hash as the canonical row (oldest = earliest
-- write wins, matches the rule the application layer was implicitly
-- assuming whenever it stamped last_action_at after onTxSubmitted).
DELETE FROM compounder_events e1
 WHERE e1.tx_hash IS NOT NULL
   AND e1.id <> (
        SELECT MIN(e2.id) FROM compounder_events e2 WHERE e2.tx_hash = e1.tx_hash
   );

-- Now safe to add the partial unique index. Postgres treats NULLs as
-- distinct in UNIQUE indexes by default (pre-15) so the partial WHERE
-- clause is the safe-and-explicit way to scope the constraint to rows
-- that actually carry a tx hash.
CREATE UNIQUE INDEX IF NOT EXISTS uq_compounder_events_tx_hash
    ON compounder_events (tx_hash)
    WHERE tx_hash IS NOT NULL;
