import { getSql, isDbConfigured } from "./db";

/**
 * Persistence layer for the unified keeper (web/app/api/keeper/cron).
 *
 * The keeper settles three user features whose ON-CHAIN state is the
 * source of truth (the Orbs TWAP book, the CCTP receiver). These helpers
 * only persist the keeper's ENGAGEMENT state:
 *
 *   - keeper_orbs_orders   : which TWAP orders the keeper has bid on and
 *                            WHEN, so a later tick knows a fill is now
 *                            past its bidDelay (the fill is a separate tx
 *                            in a separate tick from the bid).
 *   - keeper_bridge_intents: CCTP burns awaiting attestation, so the
 *                            keeper can relay receiveAndBuy the moment
 *                            Iris signs.
 *   - keeper_events        : append-only trail for the /keeper panel.
 *
 * Same soft-fail contract as compounderPersistence.ts: when the DB is
 * not configured every helper returns an empty / null result so the app
 * keeps rendering and the cron degrades to a no-op instead of throwing.
 *
 * IMPORTANT: nothing here is trusted for on-chain safety. The contracts
 * re-verify every precondition (TWAP re-checks bid/fill validity, the
 * CCTP receiver re-derives the beneficiary from the attested message).
 * A stale or wrong row can only waste a read or a reverting gas-capped
 * tx, never move funds incorrectly.
 */

// ---------------------------------------------------------------
// Leg A: Orbs TWAP orders (limit orders + DCA)
// ---------------------------------------------------------------

export type OrbsOrderKind = "limit" | "dca";
export type OrbsOrderStatus = "active" | "completed" | "canceled";

export interface KeeperOrbsOrder {
    orderId: string;
    makerAddress: string;
    srcToken: string;
    dstToken: string;
    kind: OrbsOrderKind;
    status: OrbsOrderStatus;
    chunksTotal: number;
    chunksFilled: number;
    lastBidAt: string | null;
    lastBidTx: string | null;
    bidDelaySecs: number;
    discoveredAt: string;
    updatedAt: string;
    lastError: string | null;
}

interface RawOrbsRow {
    order_id: string | number;
    maker_address: string;
    src_token: string;
    dst_token: string;
    kind: string;
    status: string;
    chunks_total: number;
    chunks_filled: number;
    last_bid_at: string | null;
    last_bid_tx: string | null;
    bid_delay_secs: number;
    discovered_at: string;
    updated_at: string;
    last_error: string | null;
}

function mapOrbsRow(r: RawOrbsRow): KeeperOrbsOrder {
    return {
        orderId: String(r.order_id),
        makerAddress: r.maker_address,
        srcToken: r.src_token,
        dstToken: r.dst_token,
        kind: (r.kind as OrbsOrderKind) ?? "limit",
        status: (r.status as OrbsOrderStatus) ?? "active",
        chunksTotal: Number(r.chunks_total),
        chunksFilled: Number(r.chunks_filled),
        lastBidAt: r.last_bid_at,
        lastBidTx: r.last_bid_tx,
        bidDelaySecs: Number(r.bid_delay_secs),
        discoveredAt: r.discovered_at,
        updatedAt: r.updated_at,
        lastError: r.last_error,
    };
}

/**
 * Insert (or refresh) an order the keeper has discovered in the book.
 * Idempotent on order_id: a re-discovery updates the mutable columns but
 * never resets the keeper's bid lifecycle (last_bid_at) unless explicitly
 * cleared by markOrbsFilled/markOrbsClosed.
 */
export async function upsertOrbsOrder(o: {
    orderId: string;
    makerAddress: string;
    srcToken: string;
    dstToken: string;
    kind: OrbsOrderKind;
    chunksTotal: number;
    chunksFilled: number;
    bidDelaySecs: number;
}): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        INSERT INTO keeper_orbs_orders (
            order_id, maker_address, src_token, dst_token, kind,
            chunks_total, chunks_filled, bid_delay_secs, status, updated_at
        ) VALUES (
            ${o.orderId}, ${o.makerAddress.toLowerCase()}, ${o.srcToken.toLowerCase()},
            ${o.dstToken.toLowerCase()}, ${o.kind}, ${o.chunksTotal}, ${o.chunksFilled},
            ${o.bidDelaySecs}, 'active', NOW()
        )
        ON CONFLICT (order_id) DO UPDATE SET
            chunks_filled = EXCLUDED.chunks_filled,
            chunks_total  = EXCLUDED.chunks_total,
            updated_at    = NOW()
        WHERE keeper_orbs_orders.status = 'active'
    `;
}

/** Active orders the keeper is tracking, oldest-touched first. */
export async function getActiveOrbsOrders(
    limit = 50,
): Promise<KeeperOrbsOrder[]> {
    if (!isDbConfigured()) return [];
    const sql = getSql();
    const rows = (await sql`
        SELECT * FROM keeper_orbs_orders
        WHERE status = 'active'
        ORDER BY updated_at ASC
        LIMIT ${limit}
    `) as RawOrbsRow[];
    return rows.map(mapOrbsRow);
}

/** Record that the keeper submitted a winning bid this tick. */
export async function markOrbsBid(
    orderId: string,
    txHash: string,
): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_orbs_orders
        SET last_bid_at = NOW(), last_bid_tx = ${txHash},
            last_error = NULL, updated_at = NOW()
        WHERE order_id = ${orderId}
    `;
}

/**
 * Record a completed fill. Clears the bid lifecycle so the next tick
 * treats the order as needing a fresh bid for the next chunk (the
 * contract deletes the winning bid on fill).
 */
export async function markOrbsFilled(
    orderId: string,
    chunksFilled: number,
): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_orbs_orders
        SET chunks_filled = ${chunksFilled}, last_bid_at = NULL,
            last_bid_tx = NULL, last_error = NULL, updated_at = NOW()
        WHERE order_id = ${orderId}
    `;
}

/** Terminal state: order completed, canceled, or pruned on chain. */
export async function markOrbsClosed(
    orderId: string,
    status: Exclude<OrbsOrderStatus, "active">,
): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_orbs_orders
        SET status = ${status}, last_bid_at = NULL, last_bid_tx = NULL,
            updated_at = NOW()
        WHERE order_id = ${orderId}
    `;
}

export async function markOrbsError(
    orderId: string,
    message: string,
): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_orbs_orders
        SET last_error = ${message.slice(0, 500)}, updated_at = NOW()
        WHERE order_id = ${orderId}
    `;
}

// ---------------------------------------------------------------
// Leg B: CCTP bridge-and-buy relay intents
// ---------------------------------------------------------------

export type BridgeIntentKind = "buy" | "forward";
export type BridgeIntentStatus =
    | "pending"
    | "relaying"
    | "relayed"
    | "failed"
    | "expired";

export interface KeeperBridgeIntent {
    id: string;
    burnTxHash: string;
    srcDomain: number;
    receiverAddress: string | null;
    beneficiaryAddress: string | null;
    intentKind: BridgeIntentKind;
    status: BridgeIntentStatus;
    attempts: number;
    relayTxHash: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
    relayedAt: string | null;
}

interface RawBridgeRow {
    id: string | number;
    burn_tx_hash: string;
    src_domain: number;
    receiver_address: string | null;
    beneficiary_address: string | null;
    intent_kind: string;
    status: string;
    attempts: number;
    relay_tx_hash: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
    relayed_at: string | null;
}

function mapBridgeRow(r: RawBridgeRow): KeeperBridgeIntent {
    return {
        id: String(r.id),
        burnTxHash: r.burn_tx_hash,
        srcDomain: Number(r.src_domain),
        receiverAddress: r.receiver_address,
        beneficiaryAddress: r.beneficiary_address,
        intentKind: (r.intent_kind as BridgeIntentKind) ?? "buy",
        status: (r.status as BridgeIntentStatus) ?? "pending",
        attempts: Number(r.attempts),
        relayTxHash: r.relay_tx_hash,
        lastError: r.last_error,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        relayedAt: r.relayed_at,
    };
}

/**
 * Record a bridge intent the moment the user's burn lands on the source
 * chain. Idempotent on burn_tx_hash: a client retry (or a page refresh
 * that re-submits) is a no-op, never a duplicate relay. Returns true if
 * a NEW row was inserted, false if it already existed.
 */
export async function recordBridgeIntent(i: {
    burnTxHash: string;
    srcDomain: number;
    receiverAddress?: string | null;
    beneficiaryAddress?: string | null;
    intentKind: BridgeIntentKind;
}): Promise<boolean> {
    if (!isDbConfigured()) return false;
    const sql = getSql();
    const rows = (await sql`
        INSERT INTO keeper_bridge_intents (
            burn_tx_hash, src_domain, receiver_address, beneficiary_address, intent_kind
        ) VALUES (
            ${i.burnTxHash.toLowerCase()}, ${i.srcDomain},
            ${i.receiverAddress?.toLowerCase() ?? null},
            ${i.beneficiaryAddress?.toLowerCase() ?? null}, ${i.intentKind}
        )
        ON CONFLICT (burn_tx_hash) DO NOTHING
        RETURNING id
    `) as { id: string | number }[];
    return rows.length > 0;
}

/**
 * Count of intents currently awaiting attestation. The intent API uses this
 * to refuse new inserts once the pending backlog is implausibly large, so an
 * unauthenticated spammer cannot grow the table without bound. Returns 0 when
 * the DB is unconfigured (the API then soft-fails open, which is fine: no DB
 * means no keeper relay anyway).
 */
export async function countPendingBridgeIntents(): Promise<number> {
    if (!isDbConfigured()) return 0;
    const sql = getSql();
    const rows = (await sql`
        SELECT COUNT(*)::int AS n FROM keeper_bridge_intents
        WHERE status = 'pending'
    `) as { n: number }[];
    return rows[0]?.n ?? 0;
}

/** Pending/in-flight intents the keeper should poll, oldest first. */
export async function getOpenBridgeIntents(
    limit = 25,
): Promise<KeeperBridgeIntent[]> {
    if (!isDbConfigured()) return [];
    const sql = getSql();
    const rows = (await sql`
        SELECT * FROM keeper_bridge_intents
        WHERE status IN ('pending', 'relaying')
        ORDER BY created_at ASC
        LIMIT ${limit}
    `) as RawBridgeRow[];
    return rows.map(mapBridgeRow);
}

/** Claim an intent for relay (pending -> relaying) and bump attempts. */
export async function markBridgeRelaying(id: string): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_bridge_intents
        SET status = 'relaying', attempts = attempts + 1, updated_at = NOW()
        WHERE id = ${id}
    `;
}

export async function markBridgeRelayed(
    id: string,
    relayTxHash: string,
): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_bridge_intents
        SET status = 'relayed', relay_tx_hash = ${relayTxHash},
            last_error = NULL, relayed_at = NOW(), updated_at = NOW()
        WHERE id = ${id}
    `;
}

/**
 * The message's CCTP nonce is already consumed on-chain (relayed by a prior
 * tick whose receipt timed out, by a concurrent run, or by the user's manual
 * claim). Mark the intent done WITHOUT a relay tx of our own, so it stops
 * being polled and is never mis-reported as 'failed'. This is the leg-B
 * idempotency guard (mirrors leg A re-reading on-chain order state).
 */
export async function markBridgeConsumed(id: string): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_bridge_intents
        SET status = 'relayed', last_error = NULL, relayed_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND status <> 'relayed'
    `;
}

/**
 * Relay attempt failed. Reset to 'pending' so a later tick retries,
 * unless it has already burned through maxAttempts, in which case park
 * it as 'failed' so the keeper stops paying gas on a doomed message.
 */
export async function markBridgeRetryOrFail(
    id: string,
    message: string,
    maxAttempts: number,
): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_bridge_intents
        SET status = CASE WHEN attempts >= ${maxAttempts} THEN 'failed' ELSE 'pending' END,
            last_error = ${message.slice(0, 500)}, updated_at = NOW()
        WHERE id = ${id}
    `;
}

/** The hookData deadline passed; the receiver would refund. Stop trying. */
export async function markBridgeExpired(id: string): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_bridge_intents
        SET status = 'expired', updated_at = NOW()
        WHERE id = ${id}
    `;
}

/**
 * Bulk-expire EVERY pending intent older than maxAgeSecs in one statement
 * (not one-at-a-time as they surface in the poll window). This bounds the
 * queue against an unauthenticated flood: junk that never attests can only
 * occupy the pending set for maxAgeSecs, not until the keeper happens to
 * poll each row. Returns the number expired.
 */
export async function expireAgedPendingIntents(
    maxAgeSecs: number,
): Promise<number> {
    if (!isDbConfigured()) return 0;
    const sql = getSql();
    const rows = (await sql`
        UPDATE keeper_bridge_intents
        SET status = 'expired', updated_at = NOW()
        WHERE status = 'pending'
          AND created_at < NOW() - (${maxAgeSecs} * INTERVAL '1 second')
        RETURNING id
    `) as { id: string | number }[];
    return rows.length;
}

/** Prune terminal rows older than olderThanSecs to bound table growth. */
export async function pruneTerminalIntents(olderThanSecs: number): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        DELETE FROM keeper_bridge_intents
        WHERE status IN ('relayed', 'expired', 'failed')
          AND updated_at < NOW() - (${olderThanSecs} * INTERVAL '1 second')
    `;
}

// ---------------------------------------------------------------
// Single-run lease lock
// ---------------------------------------------------------------

/**
 * Try to take the keeper's single-run lease for the next `leaseSecs`. Returns
 * true iff acquired (the lease was unheld or expired). Overlapping runs get
 * false and should exit immediately. Atomic: the INSERT ... ON CONFLICT DO
 * UPDATE ... WHERE only writes when the lease is free, and RETURNING tells us
 * whether we won. Works over Neon's stateless HTTP driver (unlike session
 * advisory locks). Fails OPEN (returns true) when the DB is unconfigured so a
 * no-DB deploy still runs single-threaded via the caller.
 */
export async function tryAcquireKeeperLease(
    leaseSecs: number,
    holder: string,
): Promise<boolean> {
    if (!isDbConfigured()) return true;
    const sql = getSql();
    const rows = (await sql`
        INSERT INTO keeper_lock (id, locked_until, holder)
        VALUES (1, NOW() + (${leaseSecs} * INTERVAL '1 second'), ${holder})
        ON CONFLICT (id) DO UPDATE
            SET locked_until = NOW() + (${leaseSecs} * INTERVAL '1 second'),
                holder = ${holder}
            WHERE keeper_lock.locked_until < NOW()
        RETURNING id
    `) as { id: number }[];
    return rows.length > 0;
}

/**
 * Release the lease early (best-effort; it self-expires regardless). Only
 * clears it when WE still hold it (holder match), so an overrunning run whose
 * lease already self-expired and was re-taken by a successor cannot clobber
 * the successor's lease.
 */
export async function releaseKeeperLease(holder: string): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE keeper_lock SET locked_until = NOW()
        WHERE id = 1 AND holder = ${holder}
    `;
}

// ---------------------------------------------------------------
// Event log
// ---------------------------------------------------------------

export type KeeperLeg = "orbs" | "cctp";

export async function insertKeeperEvent(e: {
    leg: KeeperLeg;
    eventType:
        | "bid"
        | "fill"
        | "complete"
        | "prune"
        | "relay"
        | "skip"
        | "error";
    refId?: string | null;
    txHash?: string | null;
    detail?: Record<string, unknown>;
}): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        INSERT INTO keeper_events (leg, event_type, ref_id, tx_hash, detail)
        VALUES (${e.leg}, ${e.eventType}, ${e.refId ?? null}, ${e.txHash ?? null},
                ${JSON.stringify(e.detail ?? {})}::jsonb)
    `;
}

export interface KeeperEvent {
    id: string;
    leg: KeeperLeg;
    eventType: string;
    refId: string | null;
    txHash: string | null;
    detail: Record<string, unknown>;
    createdAt: string;
}

/** Recent events for the /keeper observability panel. */
export async function getRecentKeeperEvents(
    limit = 50,
): Promise<KeeperEvent[]> {
    if (!isDbConfigured()) return [];
    const sql = getSql();
    const rows = (await sql`
        SELECT * FROM keeper_events
        ORDER BY created_at DESC
        LIMIT ${limit}
    `) as {
        id: string | number;
        leg: string;
        event_type: string;
        ref_id: string | null;
        tx_hash: string | null;
        detail: Record<string, unknown>;
        created_at: string;
    }[];
    return rows.map((r) => ({
        id: String(r.id),
        leg: r.leg as KeeperLeg,
        eventType: r.event_type,
        refId: r.ref_id,
        txHash: r.tx_hash,
        detail: r.detail ?? {},
        createdAt: r.created_at,
    }));
}
