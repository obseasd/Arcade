-- Unified keeper backend tables.
--
-- ONE self-hosted keeper process settles three user-facing features that
-- otherwise sit idle on testnet (and would sit idle on mainnet):
--   * Orbs TWAP limit orders  (leg A)  -- bid + fill open order chunks
--   * DCA schedules           (leg A)  -- same contract: a multi-chunk
--                                          TWAP order IS a DCA schedule
--   * CCTP bridge-and-buy     (leg B)  -- relay the attested message so
--                                          the buy auto-completes on Arc
--
-- Design mirrors 002_compounder.sql: the ON-CHAIN state is the source of
-- truth (the TWAP book, the CCTP receiver). These tables only hold the
-- keeper's *engagement* state -- which orders it has bid on and WHEN (so
-- the next tick knows a fill is now past its bidDelay), which bridge
-- intents are waiting on Iris -- plus a small event log for the /keeper
-- observability panel. Every write goes through keeperPersistence.ts and
-- soft-fails when DATABASE_URL is unset (isDbConfigured()).

-- ---------------------------------------------------------------
-- Leg A: Orbs TWAP order engagement (limit orders + DCA)
-- ---------------------------------------------------------------
-- One row per TWAP book id the keeper has ever touched. The keeper's
-- fill flow is inherently TWO-PHASE across ticks: bid() records the
-- winning taker, then fill() is only valid after bid.time + bidDelay.
-- So a tick that just bid an order must NOT try to fill it in the same
-- tick -- it records last_bid_at here and a later tick fills once the
-- delay has elapsed. `next_action` is the keeper's own view; the
-- contract re-verifies every precondition, so a stale row can never
-- cause an invalid on-chain action, only a wasted read.
CREATE TABLE IF NOT EXISTS keeper_orbs_orders (
    -- The TWAP.book[] index. uint64 on chain, fits BIGINT.
    order_id            BIGINT PRIMARY KEY,
    maker_address       VARCHAR(42) NOT NULL,
    src_token           VARCHAR(42) NOT NULL,
    dst_token           VARCHAR(42) NOT NULL,
    -- 'limit' (single chunk) | 'dca' (multi-chunk). Cosmetic: derived
    -- from srcBidAmount < srcAmount at discovery, used only for the
    -- dashboard label. The keeper serves both identically.
    kind                VARCHAR(8) NOT NULL DEFAULT 'limit',
    -- 'active' | 'completed' | 'canceled'. Mirrors the on-chain status
    -- (deadline timestamp => active; STATUS_COMPLETED/STATUS_CANCELED).
    status              VARCHAR(12) NOT NULL DEFAULT 'active',
    -- Chunk bookkeeping copied from the last fill for the dashboard.
    chunks_total        INTEGER NOT NULL DEFAULT 1,
    chunks_filled       INTEGER NOT NULL DEFAULT 0,
    -- The keeper's own bid lifecycle. last_bid_at is the wall-clock the
    -- keeper submitted a winning bid; the fill tick compares
    -- now > last_bid_at + bidDelay before attempting fill().
    last_bid_at         TIMESTAMPTZ,
    last_bid_tx         VARCHAR(66),
    -- bidDelay (seconds) copied from the order so the fill tick does not
    -- re-read the book just to know the delay.
    bid_delay_secs      INTEGER NOT NULL DEFAULT 30,
    discovered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error          TEXT
);

-- The tick scans active orders oldest-touched-first so a stuck order
-- cannot starve the rest. Partial index keeps the scan tiny once most
-- orders complete.
CREATE INDEX IF NOT EXISTS idx_keeper_orbs_active
    ON keeper_orbs_orders (updated_at)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_keeper_orbs_maker
    ON keeper_orbs_orders (maker_address);

-- ---------------------------------------------------------------
-- Leg B: CCTP bridge-and-buy relay intents
-- ---------------------------------------------------------------
-- Recorded by /api/bridge/intent the moment a user's depositForBurn
-- lands on the SOURCE chain. The keeper polls Circle Iris for each
-- pending intent; once the attestation is ready it relays
-- receiveAndBuy(message, attestation) on Arc so the buy auto-completes
-- without the user coming back to click "claim". Safe to relay from any
-- wallet: the receiver takes the beneficiary from the ATTESTED message,
-- not from the caller (destinationCaller is pinned to the receiver), so
-- the keeper can never redirect funds -- it only pays Arc gas.
CREATE TABLE IF NOT EXISTS keeper_bridge_intents (
    id                  BIGSERIAL PRIMARY KEY,
    -- The burn tx on the source chain, used as the Iris lookup key and
    -- the idempotency key (a user re-submitting the same burn is a
    -- no-op insert).
    burn_tx_hash        VARCHAR(66) NOT NULL,
    -- Circle CCTP source domain (0=Ethereum, 6=Base, ...). Iris is
    -- queried as /v2/messages/{srcDomain}?transactionHash={burn}.
    src_domain          INTEGER NOT NULL,
    -- The receiver this bridge targets (mintRecipient in the message).
    -- Stored so a receiver redeploy does not strand in-flight intents:
    -- the keeper relays against whatever receiver the message names, and
    -- this column is only for display / filtering.
    receiver_address    VARCHAR(42),
    -- The beneficiary that will receive the bought token (decoded from
    -- hookData at record time for the dashboard; the CONTRACT re-derives
    -- it from the attested message, this copy is never trusted on-chain).
    beneficiary_address VARCHAR(42),
    -- 'buy' | 'forward'. Whether hookData carries a buy (600-byte
    -- message) or a plain forward (408-byte). Only display.
    intent_kind         VARCHAR(8) NOT NULL DEFAULT 'buy',
    -- 'pending' (awaiting attestation) | 'relaying' | 'relayed' |
    -- 'failed' | 'expired'. expired = deadline in hookData passed before
    -- we could relay (the contract would refund USDC to the beneficiary;
    -- we stop retrying).
    status              VARCHAR(12) NOT NULL DEFAULT 'pending',
    attempts            INTEGER NOT NULL DEFAULT 0,
    relay_tx_hash       VARCHAR(66),
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    relayed_at          TIMESTAMPTZ
);

-- One intent per burn tx: a client retrying the record call must not
-- create a duplicate relay.
CREATE UNIQUE INDEX IF NOT EXISTS idx_keeper_bridge_burn
    ON keeper_bridge_intents (burn_tx_hash);

-- The keeper polls pending intents oldest-first.
CREATE INDEX IF NOT EXISTS idx_keeper_bridge_pending
    ON keeper_bridge_intents (created_at)
    WHERE status = 'pending' OR status = 'relaying';

-- ---------------------------------------------------------------
-- Keeper event log (observability)
-- ---------------------------------------------------------------
-- Append-only trail for the /keeper status panel and post-mortems.
-- Never read on the hot path; purely for humans.
CREATE TABLE IF NOT EXISTS keeper_events (
    id              BIGSERIAL PRIMARY KEY,
    -- 'orbs' | 'cctp'
    leg             VARCHAR(8) NOT NULL,
    -- 'bid' | 'fill' | 'complete' | 'prune' | 'relay' | 'skip' | 'error'
    event_type      VARCHAR(16) NOT NULL,
    -- order_id (leg=orbs) or bridge intent id (leg=cctp), as text so one
    -- column serves both id spaces.
    ref_id          VARCHAR(32),
    tx_hash         VARCHAR(66),
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_keeper_events_recent
    ON keeper_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_keeper_events_ref
    ON keeper_events (leg, ref_id, created_at DESC);

-- ---------------------------------------------------------------
-- Single-run lease lock
-- ---------------------------------------------------------------
-- The keeper cron has no external scheduler lock, so two overlapping HTTP
-- triggers (a slow tick + the next tick) could act on the same order /
-- intent with the same wallet. Postgres session advisory locks do NOT
-- survive Neon's stateless HTTP driver (each query is its own connection),
-- so we use a single-row time-lease instead: a run atomically takes the
-- lease iff it is unheld/expired, and overlapping runs skip. The lease
-- self-expires so a crashed run never wedges the keeper.
CREATE TABLE IF NOT EXISTS keeper_lock (
    id              INT PRIMARY KEY,
    locked_until    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Per-run token of the current holder. Release only clears the lease
    -- when this matches, so an overrunning run can never clobber a
    -- successor that already re-acquired the (self-expired) lease.
    holder          VARCHAR(64)
);
