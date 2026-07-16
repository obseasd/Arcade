import { NextRequest, NextResponse } from "next/server";
import {
    getClaimableUsdMicros,
    isReferralPayoutEnabled,
    reserveClaim,
    settleClaim,
    releaseClaim,
    sendUsdcFromTreasury,
    verifyClaimSignature,
} from "@/lib/referralPayout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/referral/claim  { referrer, deadline, signature }
 *
 * Pays a referrer their on-chain-VERIFIED claimable earnings in USDC.
 *
 * Safe-by-default AND safe-when-enabled:
 *  - Returns { enabled: false } unless REFERRAL_PAYOUT_ENABLED is set.
 *  - Claimable comes from getClaimableUsdMicros, which recomputes from
 *    on-chain via getVerifiedEarningsUsdMicros (a hard 0 until the indexer is
 *    wired), so it can NEVER pay from the forgeable referral_activity table.
 *  - Auth: the caller must present an EIP-712 signature proving control of
 *    `referrer` (fee audit 2026-07-02), so nobody can trigger / grief someone
 *    else's payout. Funds always go to `referrer` itself, never a caller-
 *    supplied recipient.
 *  - Idempotency: the claim is RESERVED (a 'pending' row) before any USDC
 *    moves. The one-pending-per-referrer unique index blocks concurrent /
 *    retried double-sends, and the reserved amount is counted as claimed so a
 *    racing request sees 0. On a send that provably never submitted the
 *    reservation is released; otherwise it settles to 'paid'.
 */
export async function POST(req: NextRequest) {
    if (!isReferralPayoutEnabled()) {
        return NextResponse.json({ ok: false, enabled: false, reason: "payout not enabled" });
    }
    let body: { referrer?: string; deadline?: string | number; signature?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    const { referrer, deadline, signature } = body;
    if (!referrer || deadline === undefined || !signature) {
        return NextResponse.json(
            { error: "referrer + deadline + signature required" },
            { status: 400 },
        );
    }
    // Deadline must be a base-10 unix-seconds integer, still in the future.
    const rawDeadline = String(deadline);
    if (!/^[0-9]+$/.test(rawDeadline)) {
        return NextResponse.json({ error: "deadline must be a unix-seconds integer" }, { status: 400 });
    }
    const deadlineSec = BigInt(rawDeadline);
    if (deadlineSec < BigInt(Math.floor(Date.now() / 1000))) {
        return NextResponse.json({ error: "signature expired" }, { status: 401 });
    }
    const authed = await verifyClaimSignature({ referrer, deadline: deadlineSec, signature });
    if (!authed) {
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }

    // --- Setup: compute + reserve. A throw here is pre-payment, safe to 500. ---
    let reservationId: number | null = null;
    let claimable = 0n;
    try {
        claimable = await getClaimableUsdMicros(referrer);
        if (claimable <= 0n) {
            return NextResponse.json({ ok: true, claimed: "0", reason: "nothing claimable" });
        }
        // Reserve BEFORE paying so a concurrent / retried request can't double
        // send. null = a claim is already in flight for this referrer.
        reservationId = await reserveClaim(referrer, claimable);
        if (reservationId === null) {
            return NextResponse.json(
                { ok: false, reason: "a claim is already in progress for this referrer" },
                { status: 409 },
            );
        }
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "claim setup failed" },
            { status: 500 },
        );
    }

    // --- Pay. sendUsdcFromTreasury awaits the receipt and only THROWS when the
    // funds provably did NOT move (pre-broadcast failure OR a definitive on-chain
    // revert), so releasing the reservation for a retry is safe. A returned hash
    // means success OR an unknown-but-broadcast tx (receipt timeout), which it
    // settles as paid to block a double-pay. ---
    let txHash: string;
    try {
        txHash = await sendUsdcFromTreasury(referrer, claimable);
    } catch (e) {
        await releaseClaim(reservationId);
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "claim failed" },
            { status: 500 },
        );
    }

    // --- Settle. The USDC is already OUT. NEVER release from here: releasing
    // would re-open `claimable` and allow a double-pay of an already-broadcast
    // transfer. If settle fails, leave the reservation in place (it keeps
    // offsetting claimable) and report paid-but-unsettled for operator
    // reconcile. ---
    try {
        await settleClaim(reservationId, txHash);
    } catch {
        return NextResponse.json({
            ok: true,
            claimed: claimable.toString(),
            txHash,
            settled: false,
        });
    }
    return NextResponse.json({ ok: true, claimed: claimable.toString(), txHash });
}
