-- Referral attribution: distinguish a PROVEN registration from a claimed one.
--
-- Why this exists. /api/referral/register is unauthenticated and the caller
-- names BOTH addresses, while attribution is first-touch-wins and permanent
-- (ON CONFLICT DO NOTHING). So anyone could POST {referred: <every wallet that
-- ever touched Arcade>, referrer: <self>} ahead of organic registration and
-- permanently own the whole user base's attribution. Rate limits do NOT close
-- that: the attacker only has to match our signup RATE, has no deadline, and
-- rotates IPs for pennies.
--
-- The signature tier (EIP-712 Register signed by the REFERRED wallet, free, no
-- gas, one popup) was added to close it -- but the route computed `verified`
-- and threw it away, because this column did not exist. A signed row was
-- byte-identical to a forged one, so the tier was a no-op and the hole it
-- documented stayed fully open.
--
-- DEFAULT false is deliberate: every pre-existing row was written by the
-- unauthenticated endpoint and must NOT be grandfathered in as proven.
ALTER TABLE referrals
    ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;

-- When the proof arrived, so an operator can reconcile and so a future rule
-- ("verified within N days of first touch") has something to key on.
ALTER TABLE referrals
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Payouts only ever read verified rows, so index for that access pattern.
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_verified
    ON referrals (referrer_address)
    WHERE verified;
