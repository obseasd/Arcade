import { NextRequest, NextResponse } from "next/server";
import {
    getClaimableUsdMicros,
    isReferralPayoutEnabled,
    recordClaim,
    sendUsdcFromTreasury,
} from "@/lib/referralPayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/referral/claim  { referrer }
 *
 * Pays a referrer their on-chain-VERIFIED claimable earnings in USDC.
 *
 * Safe-by-default: returns `{ enabled: false }` unless REFERRAL_PAYOUT_ENABLED
 * is set, and even then the claimable comes from getClaimableUsdMicros (which
 * recomputes from on-chain via getVerifiedEarningsUsdMicros — a hard 0 until
 * the indexer is wired). So this endpoint can NEVER pay from the forgeable
 * referral_activity table.
 *
 * TODO(operator) before enabling: authenticate that the caller controls
 * `referrer` (EIP-712 signature) so nobody can trigger someone else's payout
 * to a wallet they don't own. The recipient here is `referrer` itself, so the
 * funds always go to the right wallet — but auth still prevents griefing /
 * draining the budget on others' behalf.
 */
export async function POST(req: NextRequest) {
    if (!isReferralPayoutEnabled()) {
        return NextResponse.json({ ok: false, enabled: false, reason: "payout not enabled" });
    }
    let body: { referrer?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    const referrer = body.referrer;
    if (!referrer) {
        return NextResponse.json({ error: "referrer required" }, { status: 400 });
    }
    try {
        const claimable = await getClaimableUsdMicros(referrer);
        if (claimable <= 0n) {
            return NextResponse.json({ ok: true, claimed: "0", reason: "nothing claimable" });
        }
        // Pays `referrer` (the recipient is the referrer itself, never caller-
        // supplied) and records the claim so it isn't double-paid.
        const txHash = await sendUsdcFromTreasury(referrer, claimable);
        await recordClaim(referrer, claimable, txHash);
        return NextResponse.json({ ok: true, claimed: claimable.toString(), txHash });
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "claim failed" },
            { status: 500 },
        );
    }
}
