import { getSql, isDbConfigured } from "@/lib/db";

/**
 * Referral data layer (Phase 1). All addresses are stored lowercased so
 * 0xABC and 0xabc collapse to one identity. Every function soft-fails when
 * the DB isn't configured (returns a no-op result) so the app keeps running.
 */

const norm = (a: string) => a.trim().toLowerCase();
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

export interface ReferredStat {
    address: string;
    volumeUsdMicros: string;
    txCount: number;
    earnedUsdMicros: string;
    /** True only when the REFERRED wallet itself signed the attribution. */
    verified: boolean;
}
export interface ReferralStats {
    /**
     * DB-derived ESTIMATE on signature-verified rows. This is NOT what a claim
     * pays: the claim recomputes from ON-CHAIN Memo attribution (see
     * getVerifiedEarningsUsdMicros in referralPayout.ts), a different and
     * stricter source. Surfaced as an "estimate" in the UI, never as "claimable"
     * (audit C-1: the two used to be shown interchangeably, so a user saw
     * "Pending $50" then "Nothing to claim").
     */
    totalPendingUsdMicros: string;
    totalClaimedUsdMicros: string;
    /** ALL rows: volume is what the downline traded, not money owed. */
    totalVolumeUsdMicros: string;
    /** Accrual on UNPROVEN attribution. Displayed apart, never owed. */
    unverifiedPendingUsdMicros: string;
    unverifiedCount: number;
    /** VERIFIED rows only. */
    referredCount: number;
    /** Both tiers, each flagged. */
    referred: ReferredStat[];
    /**
     * The REAL, claim-backing numbers, computed from on-chain Memo attribution +
     * indexed volume by the SAME code path the /claim route pays from (audit
     * C-1). Present ONLY on the authenticated POST /stats response (that on-chain
     * scan is too heavy for the unauthenticated GET), so both are optional and
     * undefined on the coarse GET. `claimableUsdMicros` = verified earnings minus
     * already-claimed; it is the figure the UI shows as "Claimable".
     */
    verifiedEarningsUsdMicros?: string;
    claimableUsdMicros?: string;
}

/**
 * Record a referral. No-op when:
 *  - the DB is off,
 *  - either address is malformed,
 *  - referrer === referred (self-referral),
 *  - the referred wallet already has a referrer AND this call cannot beat it.
 *
 * First-touch wins AMONG UNVERIFIED rows. A VERIFIED call overrides an
 * unverified row (proof beats a claim); a verified row is never overridden by
 * anything (first PROOF wins, permanently).
 *
 * Returns true when the row was WRITTEN (inserted OR upgraded), false when the
 * call changed nothing. Note this is not "inserted": a verified override
 * returns true while inserting no row.
 */
export async function registerReferral(
    referred: string,
    referrer: string,
    verified = false,
): Promise<boolean> {
    if (!isDbConfigured() || !isAddr(referred) || !isAddr(referrer)) return false;
    const r = norm(referred);
    const ref = norm(referrer);
    if (r === ref) return false; // self-referral guard (defence in depth vs the CHECK)
    const sql = getSql();
    // A VERIFIED registration must be able to OVERRIDE an unverified one, or
    // the land-grab still wins: registration is unauthenticated and first-touch
    // is permanent, so an attacker's unsigned squat would otherwise permanently
    // beat the victim's later SIGNED registration. Only the referred wallet can
    // produce that signature, so letting proof win over a claim is exactly
    // right -- and it cannot be abused, since an attacker cannot sign for a
    // wallet they do not control.
    //
    // A verified row is NEVER overwritten (`WHERE NOT referrals.verified`):
    // first PROOF wins, permanently. Unverified rows stay first-touch-wins
    // among themselves, which is fine because they never decide money.
    //
    // The override forces a matching WIPE of referral_activity. Without it the
    // override RE-ATTRIBUTES HISTORY: activity is keyed on referred_address
    // alone, so the totals sitting there were accrued under the OLD referrer and
    // would silently become the NEW referrer's the instant the row flips. Nobody
    // is entitled to them -- the old referrer was never proven, and the new one
    // demonstrably did not refer those trades (they predate the proof) -- so both
    // get zero and the proven referrer accrues from now on. This was impossible
    // before the override existed (attribution was permanent), so the wipe is
    // part of the same change, not a pre-existing bug.
    //
    // Single statement on purpose: the neon HTTP driver gives no multi-statement
    // transaction here, and an upsert that lands without its wipe is exactly the
    // re-attribution being prevented. CTEs share one snapshot, so `prev` reads
    // the pre-upsert referrer, and `wipe` is ordered after `upsert` by reading
    // its RETURNING output.
    const rows = (await sql`
        WITH prev AS (
            SELECT referrer_address FROM referrals WHERE referred_address = ${r}
        ),
        upsert AS (
            INSERT INTO referrals (referred_address, referrer_address, verified, verified_at)
            VALUES (${r}, ${ref}, ${verified}::boolean, ${verified ? new Date().toISOString() : null})
            ON CONFLICT (referred_address) DO UPDATE
                SET referrer_address = EXCLUDED.referrer_address,
                    verified = EXCLUDED.verified,
                    verified_at = EXCLUDED.verified_at
                WHERE ${verified}::boolean AND NOT referrals.verified
            RETURNING referred_address
        ),
        wipe AS (
            DELETE FROM referral_activity
            WHERE referred_address = ${r}
              AND EXISTS (SELECT 1 FROM upsert)
              AND EXISTS (SELECT 1 FROM prev)
              AND (SELECT referrer_address FROM prev) <> ${ref}
            RETURNING referred_address
        )
        SELECT referred_address FROM upsert
    `) as { referred_address: string }[];
    return rows.length > 0;
}

/**
 * Accrue a trade against the trader's referrer (if any). Adds volume, one
 * tx, and `earnedUsdMicros` (the referrer's 10%-of-protocol-fee share) onto
 * the referred wallet's running totals. No-op when the trader has no
 * referrer. Returns true when a row was touched.
 */
export async function trackReferralTrade(
    trader: string,
    volumeUsdMicros: bigint,
    earnedUsdMicros: bigint,
): Promise<boolean> {
    if (!isDbConfigured() || !isAddr(trader)) return false;
    if (volumeUsdMicros <= 0n) return false;
    const t = norm(trader);
    const sql = getSql();
    // Only insert activity for a wallet that actually has a referrer.
    const rows = (await sql`
        INSERT INTO referral_activity (referred_address, volume_usd_micros, tx_count, earned_usd_micros, updated_at)
        SELECT ${t}, ${volumeUsdMicros.toString()}::bigint, 1, ${earnedUsdMicros.toString()}::bigint, now()
        WHERE EXISTS (SELECT 1 FROM referrals WHERE referred_address = ${t})
        ON CONFLICT (referred_address) DO UPDATE SET
            volume_usd_micros = referral_activity.volume_usd_micros + EXCLUDED.volume_usd_micros,
            tx_count          = referral_activity.tx_count + 1,
            earned_usd_micros = referral_activity.earned_usd_micros + EXCLUDED.earned_usd_micros,
            updated_at        = now()
        RETURNING referred_address
    `) as { referred_address: string }[];
    return rows.length > 0;
}

/**
 * Dashboard data for a referrer: per-referred stats + rolled-up totals.
 *
 * Splits on `verified`. An UNVERIFIED row is a CLAIM, not a fact: /register is
 * unauthenticated and the caller names both addresses, so a land-grabber can
 * assert "I referred this wallet" about wallets they have never met. Rolling
 * those into `totalPendingUsdMicros` renders a forged downline as real money in
 * the squatter's dashboard, which is the entire point of the attack. They are
 * returned, but apart, and never as "pending".
 */
export async function getReferralStats(referrer: string): Promise<ReferralStats> {
    const empty: ReferralStats = {
        totalPendingUsdMicros: "0",
        totalClaimedUsdMicros: "0",
        totalVolumeUsdMicros: "0",
        unverifiedPendingUsdMicros: "0",
        unverifiedCount: 0,
        referredCount: 0,
        referred: [],
    };
    if (!isDbConfigured() || !isAddr(referrer)) return empty;
    const ref = norm(referrer);
    const sql = getSql();
    const rows = (await sql`
        SELECT r.referred_address AS address,
               r.verified                        AS verified,
               COALESCE(a.volume_usd_micros, 0)  AS volume_usd_micros,
               COALESCE(a.tx_count, 0)           AS tx_count,
               COALESCE(a.earned_usd_micros, 0)  AS earned_usd_micros
        FROM referrals r
        LEFT JOIN referral_activity a ON a.referred_address = r.referred_address
        WHERE r.referrer_address = ${ref}
        ORDER BY r.verified DESC, COALESCE(a.earned_usd_micros, 0) DESC
    `) as {
        address: string;
        verified: boolean;
        volume_usd_micros: string | number;
        tx_count: number;
        earned_usd_micros: string | number;
    }[];

    let totalPending = 0n;
    let totalVolume = 0n;
    let unverifiedPending = 0n;
    let unverifiedCount = 0;
    const referred: ReferredStat[] = rows.map((row) => {
        const earned = BigInt(row.earned_usd_micros);
        const volume = BigInt(row.volume_usd_micros);
        // `verified` arrives as a real boolean from pg; the === guards against a
        // driver handing back the string "f", which is truthy and would quietly
        // promote every unproven row back into the payable bucket.
        const isVerified = row.verified === true;
        // Volume is NOT money owed -- it is what the downline traded, and it is
        // true whoever gets credit for it. Gating it on `verified` made the
        // headline read $0 while the table right below listed per-wallet volumes
        // above zero, a contradiction the unverified note never explained
        // (it speaks only to the pending number). Only `pending` is gated.
        totalVolume += volume;
        if (isVerified) {
            totalPending += earned;
        } else {
            unverifiedPending += earned;
            unverifiedCount += 1;
        }
        return {
            address: row.address,
            volumeUsdMicros: volume.toString(),
            txCount: Number(row.tx_count),
            earnedUsdMicros: earned.toString(),
            verified: isVerified,
        };
    });
    // Sum of settled claims (Phase 2). Wrapped so the dashboard still loads if
    // the 007_referral_claims migration hasn't been applied yet.
    let totalClaimed = 0n;
    try {
        const claimedRows = (await sql`
            SELECT COALESCE(SUM(amount_usd_micros), 0) AS claimed
            FROM referral_claims
            WHERE referrer_address = ${ref} AND status = 'paid'
        `) as { claimed: string | number }[];
        totalClaimed = BigInt(claimedRows[0]?.claimed ?? 0);
    } catch {
        /* referral_claims (007) not applied yet - treat as 0 */
    }

    return {
        // Pending = the display-only accrual on PROVEN attribution; Claimed =
        // actually-settled payouts.
        totalPendingUsdMicros: totalPending.toString(),
        totalClaimedUsdMicros: totalClaimed.toString(),
        totalVolumeUsdMicros: totalVolume.toString(),
        unverifiedPendingUsdMicros: unverifiedPending.toString(),
        unverifiedCount,
        referredCount: referred.length - unverifiedCount,
        referred,
    };
}
