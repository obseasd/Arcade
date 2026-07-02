-- Referral payout idempotency + concurrency guard (fee audit 2026-07-02).
--
-- Closes the double-pay / replay vectors flagged for Phase 2 before the
-- payout is ever enabled:
--   * uq_referral_claims_one_pending: at most ONE in-flight (pending) claim
--     per referrer, so concurrent or retried claim requests cannot each fire
--     a payout. The claim route reserves a 'pending' row BEFORE sending USDC,
--     and getClaimedUsdMicros counts pending + paid, so a reserved claim
--     immediately zeroes the referrer's claimable until it settles (-> paid)
--     or is released (deleted on a send that provably never submitted).
--   * uq_referral_claims_tx: a settlement tx_hash backs at most one claim row,
--     so a retried settle can never create a duplicate paid row.
--
-- Partial unique indexes (not table constraints) so the existing 'paid' rows
-- from 007 are unaffected and NULL tx_hash rows don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_claims_one_pending
    ON referral_claims (referrer_address)
    WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_claims_tx
    ON referral_claims (tx_hash)
    WHERE tx_hash IS NOT NULL;
