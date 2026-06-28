import { NextRequest, NextResponse } from "next/server";
import { registerReferral } from "@/lib/referralPersistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/referral/register  { referred, referrer }
 *
 * Records a first-touch referral. Idempotent + safe to call repeatedly:
 * the persistence layer rejects self-referral and keeps the FIRST referrer
 * a wallet ever had. Public (called from the frontend on wallet connect);
 * a forged registration only ever attributes the CALLER's own future fees,
 * so there's no incentive to spoof it.
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
