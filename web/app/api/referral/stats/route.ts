import { NextRequest, NextResponse } from "next/server";
import { getReferralStats } from "@/lib/referralPersistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/referral/stats?referrer=0x...
 *
 * Returns the referrer's dashboard: per-referred-wallet volume / tx count /
 * earned, plus rolled-up pending + claimed + volume totals. Soft-fails to
 * an empty payload when the DB isn't configured.
 */
export async function GET(req: NextRequest) {
    const referrer = req.nextUrl.searchParams.get("referrer");
    if (!referrer) {
        return NextResponse.json({ error: "referrer query param required" }, { status: 400 });
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
