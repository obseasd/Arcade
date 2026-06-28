import { NextRequest, NextResponse } from "next/server";
import { registerReferral } from "@/lib/referralPersistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/referral/register  { referred, referrer }
 *
 * Records a first-touch referral. Idempotent: the persistence layer rejects
 * self-referral and keeps the FIRST referrer a wallet ever had.
 *
 * SECURITY (audit 2026-06-28): UNAUTHENTICATED, and the caller chooses BOTH
 * addresses. Because attribution is first-touch-wins, an attacker can
 * land-grab a wallet that hasn't registered yet (POST {referred: victim,
 * referrer: attacker} first) and permanently attribute it to themselves.
 * Tolerable in Phase 1 (display only — no payout). Phase 2 MUST establish
 * attribution from the referred wallet's OWN first on-chain action (a
 * signature or the first trade's tx), not an anonymous POST, and recompute
 * attribution on-chain before paying anything.
 */
export async function POST(req: NextRequest) {
    let body: { referred?: string; referrer?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    const { referred, referrer } = body;
    if (!referred || !referrer) {
        return NextResponse.json({ error: "referred + referrer required" }, { status: 400 });
    }
    try {
        const inserted = await registerReferral(referred, referrer);
        return NextResponse.json({ ok: true, inserted });
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "register failed" },
            { status: 500 },
        );
    }
}
