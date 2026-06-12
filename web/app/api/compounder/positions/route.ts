import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
    getPositionsForOwner,
    upsertPosition,
    markWithdrawn,
    type CompounderMode,
} from "@/lib/compounderPersistence";
import { rateLimit } from "@/lib/apiGuard";

/**
 * /api/compounder/positions
 *
 * GET  ?owner=0x... → list of every position the wallet currently has
 *                      under auto-management (DB read).
 * POST                → upsert / withdraw a position. Called by the
 *                      frontend after the corresponding on-chain tx
 *                      lands so the DB stays in lockstep with state.
 *
 * Trust model: this route is NOT the source of truth for who owns a
 * position — the on-chain Compounder contract is. The client could
 * lie about the owner_address and we accept it because mis-reporting
 * only ever surfaces phantom rows on a wallet that doesn't really own
 * the position; the cron scanner verifies eligibility against the
 * actual contract before spending operator gas. The trade-off keeps
 * the route stateless (no signature checks, no nonce dance) which is
 * critical for the Lepton-week demo cadence.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const rl = rateLimit(req, "compounder-positions-get", 30, 60_000);
    if (rl) return rl;

    const owner = req.nextUrl.searchParams.get("owner");
    if (!owner || !isAddress(owner, { strict: false })) {
        return NextResponse.json(
            { error: "Missing or invalid owner address" },
            { status: 400 },
        );
    }

    const rows = await getPositionsForOwner(owner);
    return NextResponse.json({ positions: rows });
}

export async function POST(req: NextRequest) {
    const rl = rateLimit(req, "compounder-positions-post", 20, 60_000);
    if (rl) return rl;

    let body: {
        action: "upsert" | "withdraw";
        tokenId: string;
        ownerAddress?: string;
        mode?: CompounderMode;
        minFeeMicros?: string;
        maxSlippageBps?: number;
        token0Address?: string;
        token1Address?: string;
        feeTier?: number;
        tickLower?: number;
        tickUpper?: number;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body?.tokenId || !/^\d+$/.test(body.tokenId)) {
        return NextResponse.json({ error: "Missing tokenId" }, { status: 400 });
    }

    if (body.action === "withdraw") {
        const ok = await markWithdrawn(body.tokenId);
        return NextResponse.json({ ok });
    }

    if (body.action === "upsert") {
        if (!body.ownerAddress || !isAddress(body.ownerAddress, { strict: false })) {
            return NextResponse.json(
                { error: "Missing or invalid ownerAddress" },
                { status: 400 },
            );
        }
        if (!body.mode || !["NORMAL", "RECEIVE", "COMPOUND"].includes(body.mode)) {
            return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
        }
        if (!body.minFeeMicros || !/^\d+$/.test(body.minFeeMicros)) {
            return NextResponse.json(
                { error: "Missing minFeeMicros" },
                { status: 400 },
            );
        }
        const maxBps = body.maxSlippageBps ?? 50;
        if (maxBps < 0 || maxBps > 10_000) {
            return NextResponse.json(
                { error: "maxSlippageBps out of range" },
                { status: 400 },
            );
        }
        const ok = await upsertPosition({
            tokenId: body.tokenId,
            ownerAddress: body.ownerAddress,
            mode: body.mode,
            minFeeMicros: body.minFeeMicros,
            maxSlippageBps: maxBps,
            token0Address: body.token0Address ?? null,
            token1Address: body.token1Address ?? null,
            feeTier: body.feeTier ?? null,
            tickLower: body.tickLower ?? null,
            tickUpper: body.tickUpper ?? null,
        });
        return NextResponse.json({ ok });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
