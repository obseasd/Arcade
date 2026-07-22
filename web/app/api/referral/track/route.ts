import { NextRequest, NextResponse } from "next/server";
import { rateLimit, rejectCrossOrigin } from "@/lib/apiGuard";
import { trackReferralTrade } from "@/lib/referralPersistence";
import { computeReferralEarningsMicros } from "@/lib/referralPayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Referral economics: the DISPLAY-ONLY accrual written here MUST use the exact
// same basis as the payout (audit C-3). It previously hardcoded 5 bps while the
// payout used 15, so the dashboard "earned" and the claim amount disagreed.
// computeReferralEarningsMicros derives from the single canonical PROTOCOL_FEE_BPS
// / REFERRAL_SHARE_BPS in referralPayout.ts -- so the estimate shown here tracks
// the payout basis by construction. This number is still a DISPLAY estimate:
// real payouts recompute from on-chain Memo attribution + indexed volume, never
// this table (see the security note below).

/**
 * POST /api/referral/track  { trader, volumeUsdMicros }
 *
 * Accrues a trade against the trader's referrer (if the trader has one).
 *
 * SECURITY (audit 2026-06-28): this endpoint is UNAUTHENTICATED and the
 * caller controls `trader` + `volumeUsdMicros` freely. A malicious caller
 * can inflate ANY referred wallet's accrual to an arbitrary (bounded)
 * number, and an honest report can be replayed (no tx-hash dedup yet). This
 * is acceptable ONLY because in Phase 1 the accrual is DISPLAY-ONLY - no
 * money moves. The Phase 2 payout MUST recompute earnings exclusively from
 * on-chain events keyed by UNIQUE tx hashes, capped at fees actually
 * collected from each referred wallet, with sybil/circularity netting. It
 * must NEVER pay out `earned_usd_micros` / `pending` read from this table.
 */
export async function POST(req: NextRequest) {
    // See /register: defence in depth for the bill and for bursts, not a fix
    // for forgeability. This endpoint lets the caller name BOTH the trader and
    // the volume with no tx-hash dedup, so it is replayable by design -- which
    // is precisely why the payout path reads on-chain Memo tags instead of the
    // table this feeds. Limits are looser than /register because a real trader
    // legitimately hits this on every swap.
    const xo = rejectCrossOrigin(req);
    if (xo) return xo;
    const rl = rateLimit(req, "referral-track", 30, 60_000);
    if (rl) return rl;
    // NO global cap: rateLimit returns early, so a single IP only ever adds
    // ~10 to a shared bucket -- ~20 proxy IPs would exhaust it and 429 every
    // legitimate user on this instance. It bought nothing against the actual
    // threat (a land-grabber rotates IPs and has no deadline) while adding an
    // availability cliff to the program it was meant to protect.

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
    // Strict base-10 integer only (BigInt() would otherwise swallow hex /
    // whitespace), and a sane per-trade ceiling so a forged report can't
    // write an absurd accrual. NOTE: this number is DISPLAY-ONLY in Phase 1;
    // Phase 2 must NOT pay out from it - see audit note above.
    const rawVol = String(volumeUsdMicros);
    if (!/^[0-9]+$/.test(rawVol)) {
        return NextResponse.json({ error: "volumeUsdMicros must be a base-10 integer" }, { status: 400 });
    }
    const MAX_VOLUME_MICROS = 10_000_000_000_000n; // $10M / trade ceiling
    const volume = BigInt(rawVol);
    if (volume <= 0n) return NextResponse.json({ ok: true, tracked: false });
    if (volume > MAX_VOLUME_MICROS) {
        return NextResponse.json({ error: "volume exceeds per-trade ceiling" }, { status: 400 });
    }

    const earned = computeReferralEarningsMicros(volume);
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
