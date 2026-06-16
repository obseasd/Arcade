import { getSql, isDbConfigured } from "./db";

/**
 * Persistence layer for the V3 LP auto-compounder.
 *
 * Mirrors the on-chain PositionConfig struct in Postgres so the cron
 * scanner can decide whether a position is eligible without round-
 * tripping every config field to the contract on every tick. Writes
 * happen on three events:
 *
 *   - User deposits via the /api/compounder/positions POST route
 *     (after the on-chain depositPosition() lands).
 *   - User changes mode via the same route (PATCH).
 *   - The cron worker confirms a withdraw or a Compounded /
 *     FeesPushed event and updates the row.
 *
 * Reads happen on every page load (/positions dashboard, per-user
 * widget) and on every cron tick (full active-position scan).
 *
 * Same soft-fail contract as statsPersistence.ts: when the DB is not
 * configured, every helper returns an empty / null result so the rest
 * of the app keeps rendering.
 */

export type CompounderMode = "NORMAL" | "RECEIVE" | "COMPOUND";

export interface CompounderPosition {
    tokenId: string;
    ownerAddress: string;
    mode: CompounderMode;
    minFeeMicros: string;
    maxSlippageBps: number;
    lastActionAt: string | null;
    depositedAt: string;
    withdrawnAt: string | null;
    token0Address: string | null;
    token1Address: string | null;
    feeTier: number | null;
    tickLower: number | null;
    tickUpper: number | null;
}

export interface CompounderAction {
    id: string;
    tokenId: string;
    actionType: "compound" | "pushFees";
    params: Record<string, unknown>;
    status: "pending" | "submitting" | "succeeded" | "failed" | "skipped";
    attempts: number;
    lastError: string | null;
    txHash: string | null;
    createdAt: string;
    completedAt: string | null;
}

export interface CompounderEvent {
    id: string;
    tokenId: string;
    eventType:
        | "Compounded"
        | "FeesPushed"
        | "PositionDeposited"
        | "PositionWithdrawn"
        | "ModeChanged";
    amount0: string;
    amount1: string;
    protocolFee0: string;
    protocolFee1: string;
    usdValueMicros: string;
    txHash: string | null;
    blockNumber: string | null;
    blockAt: string;
}

interface RawPositionRow {
    token_id: string;
    owner_address: string;
    mode: CompounderMode;
    min_fee_micros: string;
    max_slippage_bps: number;
    last_action_at: string | null;
    deposited_at: string;
    withdrawn_at: string | null;
    token0_address: string | null;
    token1_address: string | null;
    fee_tier: number | null;
    tick_lower: number | null;
    tick_upper: number | null;
}

function rowToPosition(r: RawPositionRow): CompounderPosition {
    return {
        tokenId: r.token_id,
        ownerAddress: r.owner_address,
        mode: r.mode,
        minFeeMicros: r.min_fee_micros,
        maxSlippageBps: r.max_slippage_bps,
        lastActionAt: r.last_action_at,
        depositedAt: r.deposited_at,
        withdrawnAt: r.withdrawn_at,
        token0Address: r.token0_address,
        token1Address: r.token1_address,
        feeTier: r.fee_tier,
        tickLower: r.tick_lower,
        tickUpper: r.tick_upper,
    };
}

// -------------------------------------------------------------------
// Positions
// -------------------------------------------------------------------

export async function getPositionsForOwner(
    ownerAddress: string,
): Promise<CompounderPosition[]> {
    if (!isDbConfigured()) return [];
    try {
        const sql = getSql();
        const rows = (await sql`
            SELECT *
            FROM compounder_positions
            WHERE owner_address = ${ownerAddress.toLowerCase()}
              AND withdrawn_at IS NULL
            ORDER BY deposited_at DESC
        `) as unknown as RawPositionRow[];
        return rows.map(rowToPosition);
    } catch (err) {
        console.warn("[compounder] getPositionsForOwner failed:", err);
        return [];
    }
}

/** Per-tokenId aggregate of every Compounded / FeesPushed event
 *  attributed to a position owned by `ownerAddress`. Returns separate
 *  totals for amount0 and amount1 (raw token units, not USD) so the
 *  position card can render "X USDC + Y ETH" with each side priced in
 *  its own decimals, plus the USD-equivalent for the headline stat.
 *  Single SQL aggregate keeps the round-trip cost flat regardless of
 *  how many positions the user has under management. */
export interface ClaimedTotals {
    amount0: bigint;
    amount1: bigint;
    usdMicros: bigint;
}
export async function getTotalClaimedByTokenForOwner(
    ownerAddress: string,
): Promise<Map<string, ClaimedTotals>> {
    const out = new Map<string, ClaimedTotals>();
    if (!isDbConfigured()) return out;
    try {
        const sql = getSql();
        // Audit I10 sup fix: owner-history-aware attribution. An NPM
        // NFT can be withdrawn + re-deposited by a different owner
        // (the NFT trades freely between wallets), so a naive join on
        // token_id alone attributes every prior life's events to the
        // CURRENT owner. The corrected predicate uses COALESCE on
        // chain_block_at -> block_at -> NOW() so events written before
        // the migration 004 chain_block_at column still aggregate
        // (they fall back to the legacy wall-clock timestamp).
        //
        // The interval (p.deposited_at <= event_ts < COALESCE(p.withdrawn_at, NOW()))
        // is the canonical "this event happened during this owner's
        // tenure of this token" predicate; the +1 second cushion on
        // the upper bound handles same-block deposit + event
        // ordering where chain_block_at could equal withdrawn_at.
        const rows = (await sql`
            SELECT e.token_id::text AS token_id,
                   COALESCE(SUM(e.amount0), 0)::text          AS total0,
                   COALESCE(SUM(e.amount1), 0)::text          AS total1,
                   COALESCE(SUM(e.usd_value_micros), 0)::text AS total_usd
              FROM compounder_events e
              JOIN compounder_positions p ON p.token_id = e.token_id
             WHERE p.owner_address = ${ownerAddress.toLowerCase()}
               AND e.event_type IN ('Compounded', 'FeesPushed')
               AND COALESCE(e.chain_block_at, e.block_at) >= p.deposited_at
               AND COALESCE(e.chain_block_at, e.block_at) <
                   COALESCE(p.withdrawn_at + INTERVAL '1 second', NOW() + INTERVAL '1 day')
             GROUP BY e.token_id
        `) as unknown as {
            token_id: string;
            total0: string;
            total1: string;
            total_usd: string;
        }[];
        for (const row of rows) {
            out.set(row.token_id, {
                amount0: BigInt(row.total0),
                amount1: BigInt(row.total1),
                usdMicros: BigInt(row.total_usd),
            });
        }
        return out;
    } catch (err) {
        console.warn("[compounder] getTotalClaimedByTokenForOwner failed:", err);
        return out;
    }
}

export async function getPosition(
    tokenId: string,
): Promise<CompounderPosition | null> {
    if (!isDbConfigured()) return null;
    try {
        const sql = getSql();
        const rows = (await sql`
            SELECT * FROM compounder_positions WHERE token_id = ${tokenId}::BIGINT
        `) as unknown as RawPositionRow[];
        return rows.length > 0 ? rowToPosition(rows[0]) : null;
    } catch (err) {
        console.warn("[compounder] getPosition failed:", err);
        return null;
    }
}

export async function getActivePositions(): Promise<CompounderPosition[]> {
    if (!isDbConfigured()) return [];
    try {
        const sql = getSql();
        // Audit H2 fix: sort by last_action_at ASC NULLS FIRST so the
        // oldest-actioned positions get processed first on every tick.
        // Previous `ORDER BY token_id ASC` was a denial-of-service
        // surface: an attacker could mint dust positions at low token
        // IDs to permanently starve every legitimate position at higher
        // IDs out of the cron's slice(0, MAX_POSITIONS_PER_RUN). The
        // rotation here is value-neutral — anyone whose position
        // crossed its threshold and elapsed its cooldown gets serviced
        // on a fair round-robin instead of a token-id race. Never-acted
        // positions (NULL last_action_at) land at the top of the queue
        // so a fresh deposit is not starved by a flood of older
        // positions whose cooldown elapsed first.
        const rows = (await sql`
            SELECT *
            FROM compounder_positions
            WHERE withdrawn_at IS NULL
              AND mode <> 'NORMAL'
            ORDER BY last_action_at ASC NULLS FIRST, token_id ASC
        `) as unknown as RawPositionRow[];
        return rows.map(rowToPosition);
    } catch (err) {
        console.warn("[compounder] getActivePositions failed:", err);
        return [];
    }
}

/** Upsert the row for a position. Called by the on-deposit and on-mode-
 *  change API routes once the on-chain tx is mined. Mode == NORMAL keeps
 *  the row visible to the dashboard but excludes it from the cron's
 *  active scan. */
export async function upsertPosition(input: {
    tokenId: string;
    ownerAddress: string;
    mode: CompounderMode;
    minFeeMicros: string;
    maxSlippageBps: number;
    token0Address?: string | null;
    token1Address?: string | null;
    feeTier?: number | null;
    tickLower?: number | null;
    tickUpper?: number | null;
}): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            INSERT INTO compounder_positions (
                token_id,
                owner_address,
                mode,
                min_fee_micros,
                max_slippage_bps,
                token0_address,
                token1_address,
                fee_tier,
                tick_lower,
                tick_upper
            ) VALUES (
                ${input.tokenId}::BIGINT,
                ${input.ownerAddress.toLowerCase()},
                ${input.mode},
                ${input.minFeeMicros}::BIGINT,
                ${input.maxSlippageBps},
                ${input.token0Address ?? null},
                ${input.token1Address ?? null},
                ${input.feeTier ?? null},
                ${input.tickLower ?? null},
                ${input.tickUpper ?? null}
            )
            ON CONFLICT (token_id) DO UPDATE SET
                -- Audit C2 anchor: owner_address is intentionally NOT
                -- re-set on conflict so a malicious upsert that
                -- somehow slips past the route-level on-chain
                -- depositor check cannot rewrite ownership to a fresh
                -- attacker address. The route still enforces the
                -- check; this is defence in depth. Re-deposit after a
                -- withdraw goes through depositPosition on chain
                -- which the contract guards itself (NOT_OWNER),
                -- and the new row created on first deposit
                -- has the correct owner_address baked in via INSERT.
                mode             = EXCLUDED.mode,
                min_fee_micros   = EXCLUDED.min_fee_micros,
                max_slippage_bps = EXCLUDED.max_slippage_bps,
                token0_address   = COALESCE(EXCLUDED.token0_address, compounder_positions.token0_address),
                token1_address   = COALESCE(EXCLUDED.token1_address, compounder_positions.token1_address),
                fee_tier         = COALESCE(EXCLUDED.fee_tier, compounder_positions.fee_tier),
                tick_lower       = COALESCE(EXCLUDED.tick_lower, compounder_positions.tick_lower),
                tick_upper       = COALESCE(EXCLUDED.tick_upper, compounder_positions.tick_upper),
                -- Re-deposit after a prior withdraw resets the closed
                -- marker so the dashboard surfaces the row as active.
                withdrawn_at     = NULL
        `;
        return true;
    } catch (err) {
        console.error("[compounder] upsertPosition failed:", err);
        return false;
    }
}

/** 2026-06-15 audit MEDIUM fix: re-deposit by a different owner used to
 *  leak the new owner's mode/threshold/slippage onto the prior owner's
 *  position row because upsertPosition's ON CONFLICT clause keeps
 *  owner_address pinned (C2 defence). This helper is the trusted-
 *  reconciler-only path that legitimately re-stamps owner_address WHEN
 *  the row was previously withdrawn (PositionWithdrawn was observed on
 *  chain). Refreshes deposited_at so the (deposited_at, withdrawn_at)
 *  tenure window query in getTotalClaimedByTokenForOwner is correct for
 *  the new owner. The public POST route still does NOT call this; only
 *  the reconcile cron does. */
export async function restampOwnerOnRedeposit(input: {
    tokenId: string;
    ownerAddress: string;
}): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            UPDATE compounder_positions
               SET owner_address  = ${input.ownerAddress.toLowerCase()},
                   deposited_at   = NOW(),
                   withdrawn_at   = NULL
             WHERE token_id = ${input.tokenId}::BIGINT
               AND withdrawn_at IS NOT NULL
        `;
        return true;
    } catch (err) {
        console.error("[compounder] restampOwnerOnRedeposit failed:", err);
        return false;
    }
}

export async function markWithdrawn(tokenId: string): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            UPDATE compounder_positions
               SET withdrawn_at = NOW()
             WHERE token_id = ${tokenId}::BIGINT
        `;
        return true;
    } catch (err) {
        console.error("[compounder] markWithdrawn failed:", err);
        return false;
    }
}

export async function stampLastAction(
    tokenId: string,
    atIso: string,
): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            UPDATE compounder_positions
               SET last_action_at = ${atIso}::timestamptz
             WHERE token_id = ${tokenId}::BIGINT
        `;
        return true;
    } catch (err) {
        console.error("[compounder] stampLastAction failed:", err);
        return false;
    }
}

// -------------------------------------------------------------------
// Actions queue
// -------------------------------------------------------------------

interface RawActionRow {
    id: string;
    token_id: string;
    action_type: "compound" | "pushFees";
    params: Record<string, unknown>;
    status: "pending" | "submitting" | "succeeded" | "failed" | "skipped";
    attempts: number;
    last_error: string | null;
    tx_hash: string | null;
    created_at: string;
    completed_at: string | null;
}

function rowToAction(r: RawActionRow): CompounderAction {
    return {
        id: r.id,
        tokenId: r.token_id,
        actionType: r.action_type,
        params: r.params,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        txHash: r.tx_hash,
        createdAt: r.created_at,
        completedAt: r.completed_at,
    };
}

export async function enqueueAction(
    tokenId: string,
    actionType: "compound" | "pushFees",
    params: Record<string, unknown> = {},
): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            INSERT INTO compounder_actions (token_id, action_type, params)
            VALUES (${tokenId}::BIGINT, ${actionType}, ${JSON.stringify(params)}::jsonb)
        `;
        return true;
    } catch (err) {
        console.error("[compounder] enqueueAction failed:", err);
        return false;
    }
}

export async function getPendingActions(limit = 50): Promise<CompounderAction[]> {
    if (!isDbConfigured()) return [];
    try {
        const sql = getSql();
        const cap = Math.max(1, Math.min(limit, 200));
        const rows = (await sql`
            SELECT * FROM compounder_actions
             WHERE status = 'pending'
             ORDER BY created_at ASC
             LIMIT ${cap}
        `) as unknown as RawActionRow[];
        return rows.map(rowToAction);
    } catch (err) {
        console.warn("[compounder] getPendingActions failed:", err);
        return [];
    }
}

export async function markActionSubmitting(id: string): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            UPDATE compounder_actions
               SET status   = 'submitting',
                   attempts = attempts + 1
             WHERE id = ${id}::BIGINT
        `;
        return true;
    } catch (err) {
        console.error("[compounder] markActionSubmitting failed:", err);
        return false;
    }
}

export async function markActionResult(
    id: string,
    result: { status: "succeeded" | "failed" | "skipped"; txHash?: string | null; error?: string | null },
): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            UPDATE compounder_actions
               SET status       = ${result.status},
                   tx_hash      = ${result.txHash ?? null},
                   last_error   = ${result.error ?? null},
                   completed_at = NOW()
             WHERE id = ${id}::BIGINT
        `;
        return true;
    } catch (err) {
        console.error("[compounder] markActionResult failed:", err);
        return false;
    }
}

export async function getActionsForToken(
    tokenId: string,
    limit = 20,
): Promise<CompounderAction[]> {
    if (!isDbConfigured()) return [];
    try {
        const sql = getSql();
        const cap = Math.max(1, Math.min(limit, 100));
        const rows = (await sql`
            SELECT * FROM compounder_actions
             WHERE token_id = ${tokenId}::BIGINT
             ORDER BY created_at DESC
             LIMIT ${cap}
        `) as unknown as RawActionRow[];
        return rows.map(rowToAction);
    } catch (err) {
        console.warn("[compounder] getActionsForToken failed:", err);
        return [];
    }
}

// -------------------------------------------------------------------
// Events
// -------------------------------------------------------------------

interface RawEventRow {
    id: string;
    token_id: string;
    event_type: CompounderEvent["eventType"];
    amount0: string;
    amount1: string;
    protocol_fee0: string;
    protocol_fee1: string;
    usd_value_micros: string;
    tx_hash: string | null;
    block_number: string | null;
    block_at: string;
}

function rowToEvent(r: RawEventRow): CompounderEvent {
    return {
        id: r.id,
        tokenId: r.token_id,
        eventType: r.event_type,
        amount0: r.amount0,
        amount1: r.amount1,
        protocolFee0: r.protocol_fee0,
        protocolFee1: r.protocol_fee1,
        usdValueMicros: r.usd_value_micros,
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        blockAt: r.block_at,
    };
}

export async function insertEvent(input: {
    tokenId: string;
    eventType: CompounderEvent["eventType"];
    amount0?: string;
    amount1?: string;
    protocolFee0?: string;
    protocolFee1?: string;
    usdValueMicros?: string;
    txHash?: string | null;
    blockNumber?: string | null;
    /** Audit I10 sup fix: chain-authoritative block timestamp.
     *  When provided, the row's chain_block_at column is populated
     *  with the value the cron read from the receipt's block, so
     *  dashboards aggregating by timestamp use the canonical chain
     *  clock rather than the server wall clock the legacy block_at
     *  default writes. ISO-8601 string for transport compatibility
     *  with the route handler's serialisation. */
    chainBlockAtIso?: string | null;
}): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        // Audit I10 fix: idempotent insert. The migration
        // 003_compounder_events_unique_txhash.sql adds a partial
        // UNIQUE index on tx_hash where it's non-null. A retried
        // cron POST that lands after the first response was lost in
        // transit no longer double-counts.
        //
        // 2026-06-15 audit HIGH#2 fix: changed ON CONFLICT DO NOTHING
        // to a heal-empty-rows DO UPDATE so the reconciler can repair
        // zero-amount rows the cron may have written before the
        // Compounded log-parse fix shipped. Predicate restricts the
        // update to rows where amount0 = 0 AND amount1 = 0 - i.e.,
        // exactly the bad-data shape the audit identified. Healthy
        // rows are untouched, preserving the idempotency guarantee
        // for retried POSTs. Pre-migration databases (no UNIQUE
        // constraint) skip the conflict clause entirely; ON CONFLICT
        // DO UPDATE is a no-op until the index exists.
        await sql`
            INSERT INTO compounder_events (
                token_id,
                event_type,
                amount0,
                amount1,
                protocol_fee0,
                protocol_fee1,
                usd_value_micros,
                tx_hash,
                block_number,
                chain_block_at
            ) VALUES (
                ${input.tokenId}::BIGINT,
                ${input.eventType},
                ${input.amount0 ?? "0"}::NUMERIC,
                ${input.amount1 ?? "0"}::NUMERIC,
                ${input.protocolFee0 ?? "0"}::NUMERIC,
                ${input.protocolFee1 ?? "0"}::NUMERIC,
                ${input.usdValueMicros ?? "0"}::NUMERIC,
                ${input.txHash ?? null},
                ${input.blockNumber ?? null}::BIGINT,
                ${input.chainBlockAtIso ?? null}::TIMESTAMPTZ
            )
            ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO UPDATE SET
                amount0           = EXCLUDED.amount0,
                amount1           = EXCLUDED.amount1,
                protocol_fee0     = EXCLUDED.protocol_fee0,
                protocol_fee1     = EXCLUDED.protocol_fee1,
                usd_value_micros  = EXCLUDED.usd_value_micros,
                chain_block_at    = COALESCE(compounder_events.chain_block_at, EXCLUDED.chain_block_at)
            WHERE compounder_events.amount0 = 0
              AND compounder_events.amount1 = 0
        `;
        return true;
    } catch (err) {
        // 2026-06-16 follow-up: the swallow-return-false path hid every
        // schema error during the auto-compounder migration. Backfill /
        // reconcile callers got `ok: false` with no detail and Vercel
        // logs were the only diagnostic. Re-throw so the caller's
        // try/catch can surface the actual postgres error in the API
        // response. Callers without a try/catch must wrap us themselves.
        console.error("[compounder] insertEvent failed:", err);
        throw err;
    }
}

export async function getEventsForToken(
    tokenId: string,
    limit = 50,
): Promise<CompounderEvent[]> {
    if (!isDbConfigured()) return [];
    try {
        const sql = getSql();
        const cap = Math.max(1, Math.min(limit, 200));
        const rows = (await sql`
            SELECT * FROM compounder_events
             WHERE token_id = ${tokenId}::BIGINT
             ORDER BY block_at DESC
             LIMIT ${cap}
        `) as unknown as RawEventRow[];
        return rows.map(rowToEvent);
    } catch (err) {
        console.warn("[compounder] getEventsForToken failed:", err);
        return [];
    }
}

export async function getCompoundedTotalForOwner(
    ownerAddress: string,
): Promise<string> {
    if (!isDbConfigured()) return "0";
    try {
        const sql = getSql();
        const rows = (await sql`
            SELECT COALESCE(SUM(e.usd_value_micros), 0)::text AS total
              FROM compounder_events e
              JOIN compounder_positions p ON p.token_id = e.token_id
             WHERE p.owner_address = ${ownerAddress.toLowerCase()}
               AND e.event_type IN ('Compounded', 'FeesPushed')
        `) as unknown as { total: string }[];
        return rows[0]?.total ?? "0";
    } catch (err) {
        console.warn("[compounder] getCompoundedTotalForOwner failed:", err);
        return "0";
    }
}
