import { getSql, isDbConfigured } from "./db";

/**
 * Persistence layer for Twitter Escrow auto-claim. Two surfaces:
 *
 *   (1) twitter_oauth_links — canonical @handle → wallet links the
 *       /api/twitter-callback writes at OAuth completion. The cron
 *       reads this to recognise which handles can be auto-settled.
 *
 *   (2) twitter_claim_intents — every authorize-signed claim the
 *       backend has produced. The cron walks rows where
 *       execute_after <= NOW() AND status IN ('pending', 'authorized')
 *       and fires claimByTwitter(nonce) via the operator wallet.
 *
 * Same soft-fail contract as the Compounder persistence: every
 * helper returns null / empty on a missing DB so the route handlers
 * keep rendering during a Postgres outage. Migration 005 must run
 * before any of these helpers do real work.
 */

// ============================================================
// twitter_oauth_links
// ============================================================

export interface OAuthLink {
    twitterHandle: string;
    walletAddress: string;
    twitterUserId: string | null;
    oauthAt: string;
    lastClaimAt: string | null;
    revokedAt: string | null;
}

interface RawOAuthLinkRow {
    twitter_handle: string;
    wallet_address: string;
    twitter_user_id: string | null;
    oauth_at: string;
    last_claim_at: string | null;
    revoked_at: string | null;
}

function rowToOAuthLink(r: RawOAuthLinkRow): OAuthLink {
    return {
        twitterHandle: r.twitter_handle,
        walletAddress: r.wallet_address,
        twitterUserId: r.twitter_user_id,
        oauthAt: r.oauth_at,
        lastClaimAt: r.last_claim_at,
        revokedAt: r.revoked_at,
    };
}

/** Persist a fresh OAuth link. Called from /api/twitter-callback right
 *  after the EIP-712 sig is produced. A handle linking to a different
 *  wallet over its lifetime (rotation, hand-off) yields multiple rows
 *  by design so the history is auditable; only the latest non-revoked
 *  row counts for the auto-claim cron. */
export async function recordOAuthLink(input: {
    twitterHandle: string;
    walletAddress: string;
    twitterUserId?: string | null;
}): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            INSERT INTO twitter_oauth_links (
                twitter_handle,
                wallet_address,
                twitter_user_id
            ) VALUES (
                ${input.twitterHandle},
                ${input.walletAddress.toLowerCase()},
                ${input.twitterUserId ?? null}
            )
        `;
        return true;
    } catch (err) {
        console.error("[twitter] recordOAuthLink failed:", err);
        return false;
    }
}

/** Return the latest non-revoked OAuth link for a handle, or null. */
export async function getOAuthLinkForHandle(
    twitterHandle: string,
): Promise<OAuthLink | null> {
    if (!isDbConfigured()) return null;
    try {
        const sql = getSql();
        const rows = (await sql`
            SELECT twitter_handle, wallet_address, twitter_user_id,
                   oauth_at, last_claim_at, revoked_at
              FROM twitter_oauth_links
             WHERE twitter_handle = ${twitterHandle}
               AND revoked_at IS NULL
             ORDER BY oauth_at DESC
             LIMIT 1
        `) as unknown as RawOAuthLinkRow[];
        return rows.length > 0 ? rowToOAuthLink(rows[0]) : null;
    } catch (err) {
        console.warn("[twitter] getOAuthLinkForHandle failed:", err);
        return null;
    }
}

/** Mark a handle's link as revoked. Called when the user re-OAuths with
 *  a different wallet (the old wallet is no longer the canonical
 *  recipient) OR when the operator manually revokes via admin. */
export async function revokeOAuthLink(twitterHandle: string): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            UPDATE twitter_oauth_links
               SET revoked_at = NOW()
             WHERE twitter_handle = ${twitterHandle}
               AND revoked_at IS NULL
        `;
        return true;
    } catch (err) {
        console.error("[twitter] revokeOAuthLink failed:", err);
        return false;
    }
}

export async function stampLastClaim(twitterHandle: string): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            UPDATE twitter_oauth_links
               SET last_claim_at = NOW()
             WHERE twitter_handle = ${twitterHandle}
               AND revoked_at IS NULL
        `;
        return true;
    } catch (err) {
        console.error("[twitter] stampLastClaim failed:", err);
        return false;
    }
}

// ============================================================
// twitter_claim_intents
// ============================================================

export type ClaimIntentStatus =
    | "pending"
    | "authorized"
    | "claiming"
    | "succeeded"
    | "failed"
    | "stale";

export interface ClaimIntent {
    id: string;
    positionId: string;
    slotIndex: number;
    nonce: string;
    twitterHandle: string;
    recipientAddress: string;
    pairedToken: string | null;
    pairedAmount: string | null;
    clankerToken: string | null;
    clankerAmount: string | null;
    deadlineIso: string | null;
    executeAfterIso: string | null;
    status: ClaimIntentStatus;
    txHashAuthorize: string | null;
    txHashClaim: string | null;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    succeededAt: string | null;
}

interface RawClaimIntentRow {
    id: string;
    position_id: string;
    slot_index: number;
    nonce: string;
    twitter_handle: string;
    recipient_address: string;
    paired_token: string | null;
    paired_amount: string | null;
    clanker_token: string | null;
    clanker_amount: string | null;
    deadline: string | null;
    execute_after: string | null;
    status: ClaimIntentStatus;
    tx_hash_authorize: string | null;
    tx_hash_claim: string | null;
    attempts: number;
    last_error: string | null;
    created_at: string;
    succeeded_at: string | null;
}

function rowToClaimIntent(r: RawClaimIntentRow): ClaimIntent {
    return {
        id: r.id,
        positionId: r.position_id,
        slotIndex: r.slot_index,
        nonce: r.nonce,
        twitterHandle: r.twitter_handle,
        recipientAddress: r.recipient_address,
        pairedToken: r.paired_token,
        pairedAmount: r.paired_amount,
        clankerToken: r.clanker_token,
        clankerAmount: r.clanker_amount,
        deadlineIso: r.deadline,
        executeAfterIso: r.execute_after,
        status: r.status,
        txHashAuthorize: r.tx_hash_authorize,
        txHashClaim: r.tx_hash_claim,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: r.created_at,
        succeededAt: r.succeeded_at,
    };
}

/** Insert a fresh claim intent. Called from /api/twitter-callback
 *  right after the EIP-712 signature is generated. ON CONFLICT DO
 *  NOTHING on nonce makes the insert idempotent — a retried callback
 *  produces the same nonce (derived from the slot + sig nonce in the
 *  contract) and the second insert is a no-op. */
export async function insertClaimIntent(input: {
    positionId: string;
    slotIndex: number;
    nonce: string;
    twitterHandle: string;
    recipientAddress: string;
    pairedToken?: string | null;
    pairedAmount?: string | null;
    clankerToken?: string | null;
    clankerAmount?: string | null;
    deadlineIso?: string | null;
}): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            INSERT INTO twitter_claim_intents (
                position_id,
                slot_index,
                nonce,
                twitter_handle,
                recipient_address,
                paired_token,
                paired_amount,
                clanker_token,
                clanker_amount,
                deadline
            ) VALUES (
                ${input.positionId}::NUMERIC,
                ${input.slotIndex},
                ${input.nonce},
                ${input.twitterHandle},
                ${input.recipientAddress.toLowerCase()},
                ${input.pairedToken ?? null},
                ${input.pairedAmount ?? null}::NUMERIC,
                ${input.clankerToken ?? null},
                ${input.clankerAmount ?? null}::NUMERIC,
                ${input.deadlineIso ?? null}::TIMESTAMPTZ
            )
            ON CONFLICT (nonce) DO NOTHING
        `;
        return true;
    } catch (err) {
        console.error("[twitter] insertClaimIntent failed:", err);
        return false;
    }
}

/** Mark an intent as authorized after the user's authorize tx lands
 *  on chain. Carries the on-chain executeAfter so the cron can sort
 *  the work-set by readiness. Called from the reconcile worker when
 *  it sees an Authorized event AND from the manual /claim page after
 *  the user signs (eager update). */
export async function markIntentAuthorized(input: {
    nonce: string;
    executeAfterIso: string;
    txHash?: string | null;
}): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        await sql`
            UPDATE twitter_claim_intents
               SET status = 'authorized',
                   execute_after = ${input.executeAfterIso}::TIMESTAMPTZ,
                   tx_hash_authorize = COALESCE(
                       ${input.txHash ?? null},
                       tx_hash_authorize
                   )
             WHERE nonce = ${input.nonce}
               AND status IN ('pending', 'authorized')
        `;
        return true;
    } catch (err) {
        console.error("[twitter] markIntentAuthorized failed:", err);
        return false;
    }
}

/** Return the intents the cron should consider in this tick. Filters
 *  to authorized (= user signed authorize tx) + executeAfter <= NOW()
 *  + linked OAuth row exists. Caps the result so a flood of ready
 *  intents cannot push the cron past its Vercel maxDuration. */
export async function getReadyClaimIntents(
    cap: number,
): Promise<ClaimIntent[]> {
    if (!isDbConfigured()) return [];
    try {
        const sql = getSql();
        const c = Math.max(1, Math.min(cap, 25));
        const rows = (await sql`
            SELECT c.*
              FROM twitter_claim_intents c
              JOIN twitter_oauth_links l ON l.twitter_handle = c.twitter_handle
             WHERE c.status = 'authorized'
               AND c.execute_after IS NOT NULL
               AND c.execute_after <= NOW()
               AND l.revoked_at IS NULL
             ORDER BY c.execute_after ASC, c.id ASC
             LIMIT ${c}
        `) as unknown as RawClaimIntentRow[];
        return rows.map(rowToClaimIntent);
    } catch (err) {
        console.warn("[twitter] getReadyClaimIntents failed:", err);
        return [];
    }
}

export async function markIntentResult(
    nonce: string,
    result: {
        status: "claiming" | "succeeded" | "failed" | "stale";
        txHash?: string | null;
        error?: string | null;
    },
): Promise<boolean> {
    if (!isDbConfigured()) return false;
    try {
        const sql = getSql();
        // Build the SET clause dynamically to avoid double-writing the
        // succeeded_at column on every status transition.
        if (result.status === "succeeded") {
            await sql`
                UPDATE twitter_claim_intents
                   SET status         = ${result.status},
                       tx_hash_claim  = COALESCE(${result.txHash ?? null}, tx_hash_claim),
                       last_error     = NULL,
                       attempts       = attempts + 1,
                       succeeded_at   = NOW()
                 WHERE nonce = ${nonce}
            `;
        } else {
            await sql`
                UPDATE twitter_claim_intents
                   SET status         = ${result.status},
                       tx_hash_claim  = COALESCE(${result.txHash ?? null}, tx_hash_claim),
                       last_error     = ${result.error ?? null},
                       attempts       = attempts + 1
                 WHERE nonce = ${nonce}
            `;
        }
        return true;
    } catch (err) {
        console.error("[twitter] markIntentResult failed:", err);
        return false;
    }
}
