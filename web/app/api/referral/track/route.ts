import { NextRequest, NextResponse } from "next/server";
import { trackReferralTrade } from "@/lib/referralPersistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Referral economics (Phase 1 estimate; Phase 2's indexer computes the
// exact protocol fee per trade on-chain):
//   protocol fee ≈ PROTOCOL_FEE_BPS of swap volume (e.g. the V2 feeTo skim
//   is 1/6 of the 0.30% LP fee ≈ 0.05%). The referrer earns
//   REFERRAL_SHARE_BPS (10%) of THAT. So earned = volume * 5 * 1000 / 1e8.
const PROTOCOL_FEE_BPS = 5n; // 0.05% of volume goes to the protocol
const REFERRAL_SHARE_BPS = 1000n; // referrer gets 10% of the protocol cut

/**
 * POST /api/referral/track  { trader, volumeUsdMicros }
 *
 * Accrues a trade against the trader's referrer (if the trader has one).
 * Phase 1 trusts the frontend's reported volume — that's fine because a
 * forged trade only inflates the CALLER's own referrer's pending number
 * (no payout happens until Phase 2, where the indexer recomputes from
 * on-chain events before anything is paid).
 */
export async function POST(req: NextRequest) {
    let body: { trader?: string; volumeUsdMicros?: string | number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    const { trader, volumeUsdMicros } = body;
    if (!trader || volumeUsdMicros === undefined) {
        return NextResponse.json({ error: "trader + volumeUsdMicros required" }, { status: 400 });
    }
    let volume: bigint;
    try {
        volume = BigInt(volumeUsdMicros);
    } catch {
        return NextResponse.json({ error: "volumeUsdMicros must be an integer" }, { status: 400 });
    }
    if (volume <= 0n) return NextResponse.json({ ok: true, tracked: false });

    const earned = (volume * PROTOCOL_FEE_BPS * REFERRAL_SHARE_BPS) / 100_000_000n;
    try {
        const tracked = await trackReferralTrade(trader, volume, earned);
        return NextResponse.json({ ok: true, tracked });
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "track failed" },
            { status: 500 },
        );
    }
}
