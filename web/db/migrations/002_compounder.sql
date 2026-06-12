-- Compounder backend tables: per-position config (mirrors the on-chain
-- struct for fast scans), action queue (eventually-consistent triggers
-- from the GitHub Actions cron), and event history (for the per-user
-- dashboard on /positions).
--
-- All three tables key on `token_id BIGINT` — the V3 NPM token IDs are
-- uint256 on chain but fit comfortably inside BIGINT for any realistic
-- NPM lifetime (id grows monotonically, never wraps the namespace).

-- ---------------------------------------------------------------
-- Active positions
-- ---------------------------------------------------------------
-- One row per position that has been deposited into the Compounder
-- contract and is currently auto-managed. When the user withdraws on
-- chain the row gets `withdrawn_at` stamped and stays as history (the
-- /positions dashboard reads it for the lifetime total).
CREATE TABLE IF NOT EXISTS compounder_positions (
    token_id            BIGINT PRIMARY KEY,
    owner_address       VARCHAR(42) NOT NULL,
    -- 'NORMAL' | 'RECEIVE' | 'COMPOUND'. Mirrors the on-chain uint8 enum
    -- for human readability; the cron coerces to / from the integer
    -- representation when calling the contract.
    mode                VARCHAR(16) NOT NULL,
    min_fee_micros      BIGINT NOT NULL DEFAULT 0,
    max_slippage_bps    INTEGER NOT NULL DEFAULT 50,
    -- Last on-chain action timestamp pulled from the Compounded /
    -- FeesPushed event. Used by the scanner to apply the 5-min
    -- cooldown without round-tripping to the contract every tick.
    last_action_at      TIMESTAMPTZ,
    deposited_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    withdrawn_at        TIMESTAMPTZ,
    -- Pool metadata, copied at deposit time for fast dashboard
    -- rendering (avoids a round-trip to NPM.positions on every page
    -- load). The cron refreshes these lazily when an action fires.
    token0_address      VARCHAR(42),
    token1_address      VARCHAR(42),
    fee_tier            INTEGER,
    tick_lower          INTEGER,
    tick_upper          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_compounder_positions_owner
    ON compounder_positions (owner_address)
    WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_compounder_positions_active
    ON compounder_positions (token_id)
    WHERE withdrawn_at IS NULL AND mode <> 'NORMAL';

-- ---------------------------------------------------------------
-- Action queue
-- ---------------------------------------------------------------
-- The cron scanner enqueues a row here whenever a position crosses its
-- threshold; a separate worker (same Vercel function for the MVP) picks
-- pending rows up, submits the on-chain tx via the operator wallet, and
-- updates status. Splitting scan from execute lets us scale the worker
-- horizontally later without redesigning the scanner.
CREATE TABLE IF NOT EXISTS compounder_actions (
    id              BIGSERIAL PRIMARY KEY,
    token_id        BIGINT NOT NULL,
    -- 'compound' | 'pushFees'. Lowercase matches the contract function
    -- name 1:1 so logs are searchable.
    action_type     VARCHAR(16) NOT NULL,
    -- Encoded {amount0Min, amount1Min} as JSON for compound; empty for
    -- pushFees. Keeping the shape opaque means future params (deadline
    -- override, custom recipient, etc.) don't need a schema migration.
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- 'pending' | 'submitting' | 'succeeded' | 'failed' | 'skipped'.
    -- 'skipped' is the "cooldown still active" case the worker can
    -- mark without spending operator gas.
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    tx_hash         VARCHAR(66),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

-- Worker picks pending rows in FIFO order. Partial index keeps the
-- scan tiny once 99% of rows are completed.
CREATE INDEX IF NOT EXISTS idx_compounder_actions_pending
    ON compounder_actions (created_at)
    WHERE status = 'pending';

-- Per-position recent history (dashboard "Last action" lookups).
CREATE INDEX IF NOT EXISTS idx_compounder_actions_token_id
    ON compounder_actions (token_id, created_at DESC);

-- ---------------------------------------------------------------
-- Event history
-- ---------------------------------------------------------------
-- Decoded copy of Compounded / FeesPushed events so the dashboard can
-- show a chronological audit trail per user without hitting the RPC.
-- The cron's confirmation pass writes here once a submitted tx finalises.
CREATE TABLE IF NOT EXISTS compounder_events (
    id                      BIGSERIAL PRIMARY KEY,
    token_id                BIGINT NOT NULL,
    -- 'Compounded' | 'FeesPushed' | 'PositionDeposited' |
    -- 'PositionWithdrawn' | 'ModeChanged'.
    event_type              VARCHAR(32) NOT NULL,
    amount0                 NUMERIC(38, 0) NOT NULL DEFAULT 0,
    amount1                 NUMERIC(38, 0) NOT NULL DEFAULT 0,
    protocol_fee0           NUMERIC(38, 0) NOT NULL DEFAULT 0,
    protocol_fee1           NUMERIC(38, 0) NOT NULL DEFAULT 0,
    -- USDC-equivalent value the dashboard surfaces in the "compounded
    -- so far" tile. Computed off-chain via the V3 quoter at event time
    -- so we have a stable USD number even when the pool price moves.
    usd_value_micros        NUMERIC(38, 0) NOT NULL DEFAULT 0,
    tx_hash                 VARCHAR(66),
    block_number            BIGINT,
    block_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compounder_events_token_id
    ON compounder_events (token_id, block_at DESC);
