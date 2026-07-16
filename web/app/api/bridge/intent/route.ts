import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { isDbConfigured } from "@/lib/db";
import {
    recordBridgeIntent,
    countPendingBridgeIntents,
} from "@/lib/keeperPersistence";

// Refuse new intents only once the pending backlog is absurdly large. This
// is a table-GROWTH backstop, not the primary spam defense (that is the 3h
// age-expiry + the on-sight expiry of completed non-receiver burns + the
// known-receiver guard). Set high enough that an honest user is never 429'd
// even while a spammer's junk is draining: honest in-flight bridges number in
// the low tens, never thousands, so 5000 bounds storage without a self-DoS.
const MAX_PENDING_INTENTS = 5_000;

/**
 * Records a CCTP bridge-and-buy intent the moment the user's burn lands
 * on the SOURCE chain, so the unified keeper can auto-relay the buy on
 * Arc once Circle Iris attests the message. The user no longer has to
 * return and click "claim".
 *
 * This endpoint is unauthenticated by design: a bridge is a normal
 * browser action with no session, and recording an intent is HARMLESS on
 * its own -- the keeper only ever relays an ATTESTED message to a
 * receiver it recognises, and the receiver derives the beneficiary from
 * the attested message, not from anything recorded here. The worst a
 * spammed/mistyped burn hash can do is occupy an Iris poll slot until the
 * keeper age-expires it (BRIDGE_PENDING_MAX_AGE_MS). Idempotent on the
 * burn tx hash so a client retry never creates a duplicate relay.
 *
 * The client should still poll + let the user claim manually as the
 * fallback path; this only makes the happy path hands-off.
 */
export const dynamic = "force-dynamic";

interface Body {
    burnTxHash?: string;
    srcDomain?: number;
    receiverAddress?: string;
    beneficiaryAddress?: string;
    intentKind?: "buy" | "forward";
}

export async function POST(req: NextRequest) {
    if (!isDbConfigured()) {
        // Soft-fail: the manual claim flow still works, this is best-effort.
        return NextResponse.json({ recorded: false, reason: "db-not-configured" }, { status: 200 });
    }

    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }

    const burnTxHash = typeof body.burnTxHash === "string" ? body.burnTxHash.trim() : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) {
        return NextResponse.json({ error: "burnTxHash must be a 32-byte hex tx hash" }, { status: 400 });
    }

    const srcDomain = Number(body.srcDomain);
    if (!Number.isInteger(srcDomain) || srcDomain < 0 || srcDomain > 20) {
        return NextResponse.json({ error: "srcDomain out of range" }, { status: 400 });
    }

    const intentKind: "buy" | "forward" = body.intentKind === "forward" ? "forward" : "buy";

    const receiverAddress =
        typeof body.receiverAddress === "string" && isAddress(body.receiverAddress)
            ? body.receiverAddress
            : null;
    const beneficiaryAddress =
        typeof body.beneficiaryAddress === "string" && isAddress(body.beneficiaryAddress)
            ? body.beneficiaryAddress
            : null;

    // Backlog guard against unauthenticated spam.
    try {
        if ((await countPendingBridgeIntents()) >= MAX_PENDING_INTENTS) {
            return NextResponse.json(
                { recorded: false, reason: "pending-backlog-full" },
                { status: 429 },
            );
        }
    } catch {
        // Count failed: fail open (recording is best-effort anyway).
    }

    try {
        const inserted = await recordBridgeIntent({
            burnTxHash,
            srcDomain,
            receiverAddress,
            beneficiaryAddress,
            intentKind,
        });
        return NextResponse.json({ recorded: true, inserted }, { status: 200 });
    } catch (err) {
        return NextResponse.json(
            { recorded: false, error: err instanceof Error ? err.message : "db-error" },
            { status: 500 },
        );
    }
}
