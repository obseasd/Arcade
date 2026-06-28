-- Referral payout (Phase 2). Records each claim a referrer makes so
-- getClaimedUsdMicros() can subtract already-paid amounts from the
-- on-chain-verified total. Nothing is ever paid from the (forgeable)
-- referral_activity table — see lib/referralPayout.ts.
CREATE TABLE IF NOT EXISTS referral_claims (
    id                BIGSERIAL PRIMARY KEY,
    referrer_address  TEXT   NOT NULL,
    amount_usd_micros BIGINT NOT NULL CHECK (amount_usd_micros > 0),
    tx_hash           TEXT,
    status            TEXT   NOT NULL DEFAULT 'paid',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_claims_referrer
    ON referral_claims (referrer_address);
