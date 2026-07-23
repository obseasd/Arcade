import { NextRequest, NextResponse } from "next/server";
import { getReferralStats } from "@/lib/referralPersistence";
import {
    verifyClaimSignature,
    getVerifiedEarningsUsdMicros,
    getClaimedUsdMicros,
    getPerWalletVolumeSinceMicros,
    getPerWalletProtocolFeesSinceMicros,
    computeReferralEarningsMicros,
    computeReferralFromProtocolFeeMicros,
    getConfirmedReferredWallets,
} from "@/lib/referralPayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The authenticated POST runs the on-chain Memo scan (~200 getLogs windows,
// ~14s cold, then cached). The default 10s function budget would abort it.
export const maxDuration = 30;

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

        // CONFIRMED status comes from ON-CHAIN Memo attribution, not the DB
        // `verified` column. That column is only ever set by a signed register,
        // a path the client no longer walks, so it is permanently false and the
        // dashboard showed every wallet "unconfirmed" even after the user signed
        // the on-chain Memo. Worse, a wallet that confirmed on-chain but whose DB
        // registration never persisted (reported live: 0xf351..) was absent from
        // the list entirely. On-chain is the same source the payout trusts, so
        // the list and the money now agree by construction.
        let confirmedSet = new Set<string>();
        try {
            const confirmed = await getConfirmedReferredWallets(referrer);
            confirmedSet = new Set(confirmed.map((w) => w.toLowerCase()));
        } catch {
            // On-chain scan unreachable: fall back to the DB `verified` flags
            // below rather than dropping everyone's confirmed status.
        }

        // Union DB rows with on-chain-confirmed wallets missing from the DB.
        type Row = (typeof stats.referred)[number];
        const byAddr = new Map<string, Row>();
        for (const r of stats.referred) {
            byAddr.set(r.address.toLowerCase(), {
                ...r,
                verified: confirmedSet.size > 0 ? confirmedSet.has(r.address.toLowerCase()) : r.verified,
            });
        }
        for (const w of confirmedSet) {
            if (!byAddr.has(w)) {
                byAddr.set(w, {
                    address: w,
                    volumeUsdMicros: "0",
                    txCount: 0,
                    earnedUsdMicros: "0",
                    verified: true,
                });
            }
        }
        let referred = [...byAddr.values()];

        // Per-wallet volume: DISPLAY it from the subgraph, not from the DB.
        // `referral_activity.volume` is a fire-and-forget POST from the referred
        // user's browser, so it silently misses any trade where the tab closed,
        // the request failed, or the swap ran outside the app. A wallet that
        // really traded then shows 0 and is filtered out of the dashboard as
        // "inactive" -- reported live: a verified referred wallet with ~300 USDC
        // of volume never appeared. The subgraph is the same source the claimable
        // is computed from, so the list and the money now agree.
        try {
            const addrs = referred.map((r) => r.address);
            const byWallet = await getPerWalletVolumeSinceMicros(referrer, addrs);
            // Earned is a share of the REAL protocol fee each wallet generated
            // (same basis as the claimable), not a bps of gross volume. Null
            // until the subgraph ships protocolFeeUsdc, in which case earned
            // falls back to the legacy volume estimate so it is never blank.
            const feeByWallet = await getPerWalletProtocolFeesSinceMicros(referrer, addrs);
            referred = referred.map((r) => {
                const onchain = byWallet[r.address.toLowerCase()];
                if (onchain === undefined) return r;
                const feeMicros = feeByWallet ? feeByWallet[r.address.toLowerCase()] : undefined;
                const earned = !r.verified
                    ? 0n
                    : feeMicros !== undefined
                      ? computeReferralFromProtocolFeeMicros(feeMicros)
                      : computeReferralEarningsMicros(onchain);
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
        // Confirmed first, then by volume.
        referred.sort((a, b) => {
            if (a.verified !== b.verified) return a.verified ? -1 : 1;
            const av = BigInt(a.volumeUsdMicros || "0");
            const bv = BigInt(b.volumeUsdMicros || "0");
            return bv > av ? 1 : bv < av ? -1 : 0;
        });
        const totalVolume = referred.reduce((a, r) => a + BigInt(r.volumeUsdMicros || "0"), 0n);
        const verifiedCount = referred.filter((r) => r.verified).length;

        return NextResponse.json({
            ...stats,
            referred,
            referredCount: verifiedCount,
            unverifiedCount: referred.length - verifiedCount,
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
