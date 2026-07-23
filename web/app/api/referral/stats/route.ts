import { NextRequest, NextResponse } from "next/server";
import { getReferralStats } from "@/lib/referralPersistence";
import {
    verifyClaimSignature,
    getVerifiedEarningsUsdMicros,
    getClaimedUsdMicros,
    getPerWalletVolumeSinceMicros,
    computeReferralEarningsMicros,
} from "@/lib/referralPayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/referral/stats?referrer=0x...   → COARSE aggregates only
 * POST /api/referral/stats { referrer, deadline, signature } → FULL detail
 *
 * Audit 2026-07-08 (MEDIUM): the old unauthenticated GET returned the queried
 * address's entire downline - every referred wallet address plus its per-wallet
 * trading volume - so anyone could crawl the whole referral graph and read
 * per-wallet volumes (PII/BI leak; the who-referred-whom edges are off-chain
 * first-touch DB data, not derivable on-chain).
 *
 * Fix: GET now returns only rolled-up totals + a bare count (no addresses, no
 * per-wallet rows) to any caller. The sensitive per-wallet downline is served
 * ONLY via POST to a caller that proves control of `referrer` with the same
 * EIP-712 signature the /claim route uses. A referrer viewing their OWN
 * dashboard signs once to reveal their referred wallets.
 */

/** Rolled-up totals safe to expose without proving ownership. */
function coarse(stats: Awaited<ReturnType<typeof getReferralStats>>) {
    return {
        totalPendingUsdMicros: stats.totalPendingUsdMicros,
        totalClaimedUsdMicros: stats.totalClaimedUsdMicros,
        totalVolumeUsdMicros: stats.totalVolumeUsdMicros,
        unverifiedPendingUsdMicros: stats.unverifiedPendingUsdMicros,
        unverifiedCount: stats.unverifiedCount,
        referredCount: stats.referredCount,
        referred: [] as never[],
        detailWithheld: true as const,
    };
}

export async function GET(req: NextRequest) {
    const referrer = req.nextUrl.searchParams.get("referrer");
    if (!referrer) {
        return NextResponse.json({ error: "referrer query param required" }, { status: 400 });
    }
    try {
        const stats = await getReferralStats(referrer);
        return NextResponse.json(coarse(stats));
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "stats failed" },
            { status: 500 },
        );
    }
}

export async function POST(req: NextRequest) {
    let body: { referrer?: string; deadline?: string | number; signature?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }
    const { referrer, deadline, signature } = body;
    if (!referrer || deadline === undefined || !signature) {
        return NextResponse.json(
            { error: "referrer + deadline + signature required" },
            { status: 400 },
        );
    }
    let deadlineSec: bigint;
    try {
        deadlineSec = BigInt(deadline);
    } catch {
        return NextResponse.json({ error: "invalid deadline" }, { status: 400 });
    }
    if (deadlineSec < BigInt(Math.floor(Date.now() / 1000))) {
        return NextResponse.json({ error: "signature expired" }, { status: 401 });
    }
    // Proves the caller controls `referrer` - same gate as /claim. Stops a
    // third party from reading someone else's downline.
    const authed = await verifyClaimSignature({ referrer, deadline: deadlineSec, signature });
    if (!authed) {
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
    try {
        const stats = await getReferralStats(referrer);
        // The caller PROVED control of `referrer`, so it is safe (and correct)
        // to attach the REAL claim-backing numbers here (audit C-1). These come
        // from the same on-chain Memo + indexed-volume path the /claim route
        // pays from, so the dashboard's "Claimable" now equals what a claim
        // actually settles -- not the looser DB estimate in totalPendingUsdMicros.
        // Done only on this authenticated POST because the on-chain scan is far
        // too heavy for the unauthenticated GET.
        const verified = await getVerifiedEarningsUsdMicros(referrer);
        const claimed = await getClaimedUsdMicros(referrer);
        const claimable = verified > claimed ? verified - claimed : 0n;

        // Per-wallet volume: DISPLAY it from the subgraph, not from the DB.
        // `referral_activity.volume` is a fire-and-forget POST from the referred
        // user's browser, so it silently misses any trade where the tab closed,
        // the request failed, or the swap ran outside the app. A wallet that
        // really traded then shows 0 and is filtered out of the dashboard as
        // "inactive" -- reported live: a verified referred wallet with ~300 USDC
        // of volume never appeared. The subgraph is the same source the claimable
        // is computed from, so the list and the money now agree.
        let referred = stats.referred;
        try {
            const byWallet = await getPerWalletVolumeSinceMicros(
                referrer,
                referred.map((r) => r.address),
            );
            referred = referred.map((r) => {
                const onchain = byWallet[r.address.toLowerCase()];
                if (onchain === undefined) return r;
                // Only VERIFIED wallets earn, matching the payout path.
                const earned = r.verified ? computeReferralEarningsMicros(onchain) : 0n;
                return {
                    ...r,
                    volumeUsdMicros: onchain.toString(),
                    earnedUsdMicros: earned.toString(),
                };
            });
        } catch {
            // Subgraph unreachable: fall back to the DB figures rather than
            // showing an empty downline.
        }
        const totalVolume = referred.reduce((a, r) => a + BigInt(r.volumeUsdMicros || "0"), 0n);

        return NextResponse.json({
            ...stats,
            referred,
            totalVolumeUsdMicros: totalVolume.toString(),
            verifiedEarningsUsdMicros: verified.toString(),
            claimableUsdMicros: claimable.toString(),
        });
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "stats failed" },
            { status: 500 },
        );
    }
}
