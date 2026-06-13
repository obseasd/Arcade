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

/** Per-tokenId sum of compound + push-fees event values, in 6-decimal
 *  USDC micros. The cron writes `usd_value_micros` on every
 *  Compounded / FeesPushed event so this is a simple SUM(); the
 *  dashboard surfaces it as the "Total claimed" line on the position
 *  card. Returns a map keyed by tokenId for fast lookup. */
export async function getTotalClaimedByTokenForOwner(
    ownerAddress: string,
): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (!isDbConfigured()) return out;
    try {
        const sql = getSql();
        const rows = (await sql`
            SELECT e.token_id::text AS token_id,
                   COALESCE(SUM(e.usd_value_micros), 0)::text AS total
              FROM compounder_events e
              JOIN compounder_positions p ON p.token_id = e.token_id
             WHERE p.owner_address = ${ownerAddress.toLowerCase()}
               AND e.event_type IN ('Compounded', 'FeesPushed')
             GROUP BY e.token_id
        `) as unknown as { token_id: string; total: string }[];
        for (const row of rows) {
            out.set(row.token_id, BigInt(row.total));
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
        const rows = (await sql`
            SELECT *
            FROM compounder_positions
            WHERE withdrawn_at IS NULL
              AND mode <> 'NORMAL'
            ORDER BY token_id ASC
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
                owner_address    = EXCLUDED.owner_address,
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
}): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
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
                block_number
            ) VALUES (
                ${input.tokenId}::BIGINT,
                ${input.eventType},
                ${input.amount0 ?? "0"}::NUMERIC,
                ${input.amount1 ?? "0"}::NUMERIC,
                ${input.protocolFee0 ?? "0"}::NUMERIC,
                ${input.protocolFee1 ?? "0"}::NUMERIC,
                ${input.usdValueMicros ?? "0"}::NUMERIC,
                ${input.txHash ?? null},
                ${input.blockNumber ?? null}::BIGINT
            )
        `;
        return true;
    } catch (err) {
        console.error("[compounder] insertEvent failed:", err);
        return false;
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
