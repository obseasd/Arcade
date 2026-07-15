import { NextRequest, NextResponse } from "next/server";
import { getReferralStats } from "@/lib/referralPersistence";
import { verifyClaimSignature } from "@/lib/referralPayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/referral/stats?referrer=0x...   → COARSE aggregates only
 * POST /api/referral/stats { referrer, deadline, signature } → FULL detail
 *
 * Audit 2026-07-08 (MEDIUM): the old unauthenticated GET returned the queried
 * address's entire downline — every referred wallet address plus its per-wallet
 * trading volume — so anyone could crawl the whole referral graph and read
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
    // Proves the caller controls `referrer` — same gate as /claim. Stops a
    // third party from reading someone else's downline.
    const authed = await verifyClaimSignature({ referrer, deadline: deadlineSec, signature });
    if (!authed) {
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
    try {
        const stats = await getReferralStats(referrer);
        return NextResponse.json(stats);
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "stats failed" },
            { status: 500 },
        );
    }
}
