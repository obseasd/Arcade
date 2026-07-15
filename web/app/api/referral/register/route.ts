import { NextRequest, NextResponse } from "next/server";
import { registerReferral } from "@/lib/referralPersistence";
import { verifyRegisterSignature } from "@/lib/referralPayout";
import { rateLimit, rejectCrossOrigin } from "@/lib/apiGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/referral/register  { referred, referrer, deadline?, signature? }
 *
 * Records a first-touch referral. Idempotent: the persistence layer rejects
 * self-referral and keeps the FIRST referrer a wallet ever had.
 *
 * TWO TIERS, so the funnel stays frictionless while money stays safe
 * (audit 2026-07-11 B-2):
 *
 *  - NO signature -> UNVERIFIED. Recorded for DISPLAY only. This path is
 *    unauthenticated and the caller picks BOTH addresses, so it is forgeable:
 *    an attacker can land-grab wallets that haven't registered yet and, since
 *    first-touch is permanent, silently keep them. Rate limiting does NOT fix
 *    this (the attacker only has to match our signup RATE, has no deadline, and
 *    rotates IPs), so an unverified row MUST NEVER decide a payout.
 *
 *  - WITH a valid signature -> VERIFIED. The REFERRED wallet itself signed
 *    Register(referred, referrer, deadline), which nobody can forge on its
 *    behalf. Costs the user nothing: no gas, no tx, just one wallet popup at
 *    first connect. This is what payouts are allowed to trust.
 *
 * The on-chain Memo tag ([[registerReferrerCall]]) remains the stronger,
 * publicly auditable tier for anyone who wants it, but it needs a real tx and
 * is therefore not the entry ticket.
 */
export async function POST(req: NextRequest) {
    // Defence in depth, NOT the fix. A determined land-grabber rotates IPs for
    // pennies and has no deadline (being "first" for an unregistered wallet can
    // happen any time), so per-IP limits do not close the hole -- the signature
    // tier does. What these DO buy: the global cap bounds a distributed burst
    // regardless of IP rotation, and both protect the Vercel bill, which is not
    // theoretical here (this account has already been paused for Edge-request
    // overuse, and an unauthenticated POST is exactly the shape that gets
    // abused). A real user registers ONCE, ever, so 10/min per IP is generous.
    const xo = rejectCrossOrigin(req);
    if (xo) return xo;
    const rl = rateLimit(req, "referral-register", 10, 60_000);
    if (rl) return rl;
    // NO global cap: rateLimit returns early, so a single IP only ever adds
    // ~10 to a shared bucket -- ~20 proxy IPs would exhaust it and 429 every
    // legitimate user on this instance. It bought nothing against the actual
    // threat (a land-grabber rotates IPs and has no deadline) while adding an
    // availability cliff to the program it was meant to protect.

    let body: {
        referred?: string;
        referrer?: string;
        deadline?: string | number;
        signature?: string;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    const { referred, referrer, deadline, signature } = body;
    if (!referred || !referrer) {
        return NextResponse.json({ error: "referred + referrer required" }, { status: 400 });
    }

    // A signature is optional, but a PRESENT-and-INVALID one is a hard error:
    // silently downgrading it to unverified would let a caller pass garbage and
    // still land an unverified row while believing it was proven.
    let verified = false;
    if (signature) {
        if (deadline === undefined) {
            return NextResponse.json(
                { error: "deadline required with signature" },
                { status: 400 },
            );
        }
        verified = await verifyRegisterSignature({
            referred,
            referrer,
            deadline: BigInt(deadline),
            signature,
        });
        if (!verified) {
            return NextResponse.json({ error: "invalid signature" }, { status: 401 });
        }
    }

    try {
        const inserted = await registerReferral(referred, referrer);
        return NextResponse.json({ ok: true, inserted, verified });
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "register failed" },
            { status: 500 },
        );
    }
}
