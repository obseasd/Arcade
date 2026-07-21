import { NextRequest, NextResponse } from "next/server";

/**
 * Twitter escrow auto-claim cron — RETIRED (2026-07-21).
 *
 * This used to auto-settle the second step (claimByTwitter) of a timelocked
 * escrow claim. It was written against the OLD ArcadeTwitterEscrowV3 ABI, which
 * mis-decodes the deployed ArcadeTwitterEscrowV4 (different PendingClaim shape),
 * and the V4 escrow runs with claimTimelock() == 0, so there is nothing to
 * auto-settle: users complete authorize + claimByTwitter in one sitting via the
 * /claim page. It was also the only remaining consumer of the dead V3 escrow ABI
 * on this path.
 *
 * The endpoint is kept (returns 200) so the external cron-job.org schedule that
 * pings it doesn't start 404-ing; it is now a no-op. If a non-zero claimTimelock
 * is ever set on the V4 escrow, build a V4-shaped auto-claim here (read
 * pendingClaims via TWITTER_ESCROW_V4_ABI, batch claimByTwitter) rather than
 * resurrecting the V3 version.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    const secret = process.env.COMPOUNDER_CRON_SECRET;
    if (!secret) {
        return NextResponse.json({ error: "COMPOUNDER_CRON_SECRET not configured" }, { status: 500 });
    }
    const auth = req.headers.get("authorization");
    const expected = `Bearer ${secret}`;
    if (!auth || auth.length !== expected.length || auth !== expected) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({
        ran: false,
        retired: true,
        reason: "V3 auto-claim retired; V4 claims are user-driven (claimTimelock=0).",
    });
}
