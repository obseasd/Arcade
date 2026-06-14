-- Twitter Escrow auto-claim persistence (Lepton creator-economy feature).
--
-- Two tables:
--
--   twitter_oauth_links — canonical @handle → wallet map persisted at
--   OAuth-completion time. Lets the auto-claim cron recognise which
--   handles can be auto-settled (a handle without a row here is one
--   the user never finished onboarding for, so the keeper does not
--   attempt to spend gas on its behalf).
--
--   twitter_claim_intents — track the (positionId, slotIndex, nonce)
--   triple of every authorized claim the user has signed. The cron
--   reads this table, checks the contract's executeAfter timestamp,
--   and fires claimByTwitter(nonce) once the timelock has elapsed.
--   The row carries `status` so a transient cron failure can retry
--   without double-claiming (the contract itself is idempotent —
--   claimByTwitter consumes the nonce — but the row tracks intent for
--   observability + analytics).
--
-- Auth model: same anchor as the Compounder — every write path on the
-- API routes verifies on-chain ownership / OAuth state before touching
-- the DB. The cron's bearer secret is identical to the existing
-- COMPOUNDER_CRON_SECRET so the operator manages one rotation surface.

-- ----------------------------------------------------------
-- twitter_oauth_links
-- ----------------------------------------------------------
-- A handle can link multiple wallets over its lifetime (rotation,
-- multi-device) — primary key includes both so the history is
-- preserved and analytics see every link. The latest row per
-- (twitter_handle) is the live one for cron purposes.
CREATE TABLE IF NOT EXISTS twitter_oauth_links (
    id                  BIGSERIAL PRIMARY KEY,
    twitter_handle      VARCHAR(32) NOT NULL,         -- @handle WITHOUT the @
    wallet_address      VARCHAR(42) NOT NULL,         -- lowercased EVM address
    -- Twitter user ID. Optional but very useful to disambiguate rare
    -- handle squats (a user reclaims a handle the cron previously
    -- linked to a different wallet). The cron's auto-claim check
    -- prefers twitter_user_id over twitter_handle when both are set.
    twitter_user_id     VARCHAR(64),
    oauth_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Track when a claim last fired for this link so the dashboard can
    -- surface "last paid out 3h ago" and the cron can rate-limit a
    -- compromised key from spamming.
    last_claim_at       TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_twitter_oauth_handle
    ON twitter_oauth_links (twitter_handle)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_twitter_oauth_wallet
    ON twitter_oauth_links (wallet_address)
    WHERE revoked_at IS NULL;

-- ----------------------------------------------------------
-- twitter_claim_intents
-- ----------------------------------------------------------
-- Mirrors the on-chain pendingClaims[nonce] entry that authorize()
-- creates. Inserted by /api/twitter-callback right after the EIP-712
-- signature is generated (so the row exists even if the user never
-- completes the authorize tx — useful for "did the user start a claim
-- and bail?" analytics). The status column tracks lifecycle:
--
--   pending       — authorize() not yet observed on chain
--   authorized    — authorize() landed; cron waits for executeAfter
--   claiming      — cron submitted claimByTwitter(nonce); waiting receipt
--   succeeded     — claimByTwitter receipt confirmed
--   failed        — receipt reverted (the cron logs reason in last_error)
--   stale         — nonce is older than the 180-day forfeit window and
--                   was forfeited on chain; row kept for audit
--
-- Cron picks pending+authorized rows where executeAfter <= NOW() AND
-- the linked OAuth row is non-revoked.
CREATE TABLE IF NOT EXISTS twitter_claim_intents (
    id                  BIGSERIAL PRIMARY KEY,
    -- Tuple identifying the slot on chain
    position_id         NUMERIC(78, 0) NOT NULL,
    slot_index          INTEGER NOT NULL,
    nonce               VARCHAR(66) NOT NULL,           -- bytes32 hex
    twitter_handle      VARCHAR(32) NOT NULL,
    recipient_address   VARCHAR(42) NOT NULL,            -- lowercased
    -- Snapshot of the signed claim amounts so the cron can compute
    -- USDC value without re-deriving from chain state. The on-chain
    -- contract sweeps CURRENT balance on claim (audit H-04), so these
    -- are floors not the exact transferred amount. Both columns are
    -- nullable so a row inserted at OAuth time before the amounts are
    -- known still has a place to live.
    paired_token        VARCHAR(42),
    paired_amount       NUMERIC(38, 0),
    clanker_token       VARCHAR(42),
    clanker_amount      NUMERIC(38, 0),
    deadline            TIMESTAMPTZ,
    execute_after       TIMESTAMPTZ,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    tx_hash_authorize   VARCHAR(66),
    tx_hash_claim       VARCHAR(66),
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    succeeded_at        TIMESTAMPTZ
);

-- Cron picks (status, execute_after) so this index is the hot path.
CREATE INDEX IF NOT EXISTS idx_twitter_claim_intents_actionable
    ON twitter_claim_intents (execute_after)
    WHERE status IN ('pending', 'authorized');

-- Per-handle history lookup for the dashboard.
CREATE INDEX IF NOT EXISTS idx_twitter_claim_intents_handle
    ON twitter_claim_intents (twitter_handle, created_at DESC);

-- nonce is the canonical identifier on chain; UNIQUE makes the cron's
-- ON CONFLICT DO NOTHING in insertClaimIntent idempotent so a retried
-- /api/twitter-callback call cannot double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_twitter_claim_intents_nonce
    ON twitter_claim_intents (nonce);
