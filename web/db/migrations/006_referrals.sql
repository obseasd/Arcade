-- Referral system (Phase 1: attribution + accrual; payout is Phase 2).
--
-- referrals: first-touch attribution. A wallet has exactly ONE referrer,
-- forever (PRIMARY KEY on the referred address + ON CONFLICT DO NOTHING in
-- the API enforces first-touch). A self-referral is rejected by the CHECK
-- so nobody can refer themselves to farm their own fees.
CREATE TABLE IF NOT EXISTS referrals (
    referred_address  TEXT PRIMARY KEY,
    referrer_address  TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referrals_no_self CHECK (referred_address <> referrer_address)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_address);

-- referral_activity: per-referred-wallet running totals. Keyed by the
-- referred wallet (which has a single referrer via `referrals`), so a
-- referrer's dashboard is a JOIN. earned_usd_micros is the referrer's
-- accrued share (10% of the protocol fee the referred wallet generated).
CREATE TABLE IF NOT EXISTS referral_activity (
    referred_address   TEXT PRIMARY KEY
        REFERENCES referrals (referred_address) ON DELETE CASCADE,
    volume_usd_micros  BIGINT  NOT NULL DEFAULT 0,
    tx_count           INTEGER NOT NULL DEFAULT 0,
    earned_usd_micros  BIGINT  NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
