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
}
export interface ReferralStats {
    totalPendingUsdMicros: string;
    totalClaimedUsdMicros: string;
    totalVolumeUsdMicros: string;
    referredCount: number;
    referred: ReferredStat[];
}

/**
 * Record a first-touch referral. No-op when:
 *  - the DB is off,
 *  - either address is malformed,
 *  - referrer === referred (self-referral),
 *  - the referred wallet already has a referrer (first-touch wins).
 * Returns true only when a NEW row was inserted.
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
    const rows = (await sql`
        INSERT INTO referrals (referred_address, referrer_address, verified, verified_at)
        VALUES (${r}, ${ref}, ${verified}, ${verified ? new Date().toISOString() : null})
        ON CONFLICT (referred_address) DO UPDATE
            SET referrer_address = EXCLUDED.referrer_address,
                verified = EXCLUDED.verified,
                verified_at = EXCLUDED.verified_at
            WHERE ${verified} AND NOT referrals.verified
        RETURNING referred_address
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

/** Dashboard data for a referrer: per-referred stats + rolled-up totals. */
export async function getReferralStats(referrer: string): Promise<ReferralStats> {
    const empty: ReferralStats = {
        totalPendingUsdMicros: "0",
        totalClaimedUsdMicros: "0",
        totalVolumeUsdMicros: "0",
        referredCount: 0,
        referred: [],
    };
    if (!isDbConfigured() || !isAddr(referrer)) return empty;
    const ref = norm(referrer);
    const sql = getSql();
    const rows = (await sql`
        SELECT r.referred_address AS address,
               COALESCE(a.volume_usd_micros, 0)  AS volume_usd_micros,
               COALESCE(a.tx_count, 0)           AS tx_count,
               COALESCE(a.earned_usd_micros, 0)  AS earned_usd_micros
        FROM referrals r
        LEFT JOIN referral_activity a ON a.referred_address = r.referred_address
        WHERE r.referrer_address = ${ref}
        ORDER BY COALESCE(a.earned_usd_micros, 0) DESC
    `) as {
        address: string;
        volume_usd_micros: string | number;
        tx_count: number;
        earned_usd_micros: string | number;
    }[];

    let totalPending = 0n;
    let totalVolume = 0n;
    const referred: ReferredStat[] = rows.map((row) => {
        const earned = BigInt(row.earned_usd_micros);
        const volume = BigInt(row.volume_usd_micros);
        totalPending += earned;
        totalVolume += volume;
        return {
            address: row.address,
            volumeUsdMicros: volume.toString(),
            txCount: Number(row.tx_count),
            earnedUsdMicros: earned.toString(),
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
        /* referral_claims (007) not applied yet — treat as 0 */
    }

    return {
        // Pending = the display-only accrual; Claimed = actually-settled payouts.
        totalPendingUsdMicros: totalPending.toString(),
        totalClaimedUsdMicros: totalClaimed.toString(),
        totalVolumeUsdMicros: totalVolume.toString(),
        referredCount: referred.length,
        referred,
    };
}
