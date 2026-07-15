-- =====================================================================
--  REFERRAL SCHEMA — paste this whole file into the Neon SQL editor.
--  Console -> your project -> "SQL Editor" -> paste -> Run.
-- =====================================================================
--
--  WHY THIS FILE EXISTS. This repo has NO automatic migration step: the
--  original runner was a GitHub Action that was never wired into the Vercel
--  deploy. So a file in db/migrations/ does nothing until someone applies it
--  by hand, and the referral code shipped ahead of its schema:
--  registerReferral writes `verified`/`verified_at` and getReferralStats
--  SELECTs `r.verified` — all 009 columns. Against a DB without them, every
--  one of those queries throws `column "verified" does not exist`, so
--  /api/referral/register 500s on EVERY call. Registration is fire-and-forget
--  (nothing retries it), so each failure PERMANENTLY loses that wallet's
--  first-touch attribution.
--
--  There is also /api/referral/migrate, which does the same thing over HTTP.
--  It needs the COMPOUNDER_CRON_SECRET Bearer token, which lives in Vercel and
--  cannot be read back out — so this file is the path that needs no secret.
--
--  SAFE TO RE-RUN. Every statement is IF NOT EXISTS / ADD COLUMN IF NOT
--  EXISTS. On an already-migrated database this is a no-op. It never drops,
--  never truncates, and never rewrites a row.
--
--  Covers migrations 006, 007, 008 and 009 in order. 006 must come first:
--  referral_activity has a foreign key onto referrals.
-- =====================================================================


-- ---------- 006: attribution + accrual --------------------------------
-- First-touch attribution. A wallet has exactly ONE referrer. The CHECK
-- rejects self-referral so nobody can farm their own fees.
CREATE TABLE IF NOT EXISTS referrals (
    referred_address  TEXT PRIMARY KEY,
    referrer_address  TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referrals_no_self CHECK (referred_address <> referrer_address)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_address);

-- Per-referred-wallet running totals; a referrer's dashboard is a JOIN.
CREATE TABLE IF NOT EXISTS referral_activity (
    referred_address   TEXT PRIMARY KEY
        REFERENCES referrals (referred_address) ON DELETE CASCADE,
    volume_usd_micros  BIGINT  NOT NULL DEFAULT 0,
    tx_count           INTEGER NOT NULL DEFAULT 0,
    earned_usd_micros  BIGINT  NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------- 007: payout ledger ----------------------------------------
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


-- ---------- 008: payout idempotency -----------------------------------
-- At most ONE in-flight claim per referrer, so concurrent or retried claim
-- requests cannot each fire a payout.
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_claims_one_pending
    ON referral_claims (referrer_address)
    WHERE status = 'pending';

-- A settlement tx_hash backs at most one claim row, so a retried settle can
-- never create a duplicate paid row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_claims_tx
    ON referral_claims (tx_hash)
    WHERE tx_hash IS NOT NULL;


-- ---------- 009: the verified tier ------------------------------------
-- /api/referral/register is unauthenticated and the caller names BOTH
-- addresses, so an unsigned row is a CLAIM anyone can make about anyone. Only
-- a row the REFERRED wallet signed is ever counted or paid.
--
-- DEFAULT false is deliberate and load-bearing: every pre-existing row was
-- written by the unauthenticated endpoint, so grandfathering them in as proven
-- would hand a land-grabber exactly what this column exists to deny.
ALTER TABLE referrals
    ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE referrals
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_verified
    ON referrals (referrer_address)
    WHERE verified;


-- ---------- verify it worked ------------------------------------------
-- Expect 4 rows: verified, verified_at, referred_address, referrer_address.
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'referrals'
 ORDER BY ordinal_position;
