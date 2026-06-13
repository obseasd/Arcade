import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress, type Address } from "viem";
import {
    getPositionsForOwner,
    getTotalClaimedByTokenForOwner,
    upsertPosition,
    markWithdrawn,
    type CompounderMode,
} from "@/lib/compounderPersistence";
import { AUTO_COMPOUNDER_ABI } from "@/lib/abis/autoCompounder";
import { ADDRESSES } from "@/lib/constants";
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
 * Audit C2 fix: every write path now verifies on-chain ownership
 * before touching the DB. The previous version trusted the caller's
 * claimed `ownerAddress` and a 20-req/min in-memory rate limit, which
 * let any anonymous caller (a) reassign `owner_address` on someone
 * else's position via the ON CONFLICT clause and (b) soft-delete
 * (`withdrawn_at = NOW()`) any position they could guess the tokenId
 * of — a trivially exploited platform-wide DoS against the keeper
 * scanner. The fix reads the on-chain `Compounder.configs(tokenId)`
 * depositor field over the live Arc RPC and rejects every write that
 * does not match the position's recorded owner. This puts the
 * authorisation gate where the truth lives (the contract) and stays
 * stateless server-side — no per-user nonce, no EIP-712 dance, no
 * additional dependency.
 */
export const dynamic = "force-dynamic";

const ARC_CHAIN = {
    id: 5042002,
    name: "Arc Testnet",
    network: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: {
        default: { http: ["https://rpc.testnet.arc.network"] },
        public: { http: ["https://rpc.testnet.arc.network"] },
    },
} as const;

/** Returns the on-chain depositor address (i.e. who owns the auto-
 *  management slot for this tokenId), or null if the position is not
 *  currently held by the Compounder. The null case covers (a) a fresh
 *  tokenId never deposited and (b) a withdrawn one, both of which must
 *  be rejected by the write paths. */
async function readDepositor(tokenId: string): Promise<Address | null> {
    const compounderAddress = ADDRESSES.autoCompounder as Address;
    if (!isAddress(compounderAddress, { strict: false })) return null;
    if (compounderAddress === "0x0000000000000000000000000000000000000000") {
        return null;
    }
    try {
        const client = createPublicClient({
            chain: ARC_CHAIN,
            transport: http(),
        });
        const cfg = (await client.readContract({
            address: compounderAddress,
            abi: AUTO_COMPOUNDER_ABI,
            functionName: "configs",
            args: [BigInt(tokenId)],
        })) as readonly [Address, number, number, bigint, bigint];
        // Tuple shape from ArcadeAutoCompounder.PositionConfig:
        //   [0] depositor (address)
        //   [1] mode (uint8)
        //   [2] maxSlippageBps (uint16)
        //   [3] lastActionAt (uint64)
        //   [4] minFeeMicros (uint64)
        const depositor = cfg[0];
        if (
            !depositor ||
            depositor === "0x0000000000000000000000000000000000000000"
        ) {
            return null;
        }
        return depositor;
    } catch {
        return null;
    }
}

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

    const [rows, claimedByToken] = await Promise.all([
        getPositionsForOwner(owner),
        getTotalClaimedByTokenForOwner(owner),
    ]);
    // Decorate each position with cumulative claim totals so the
    // dashboard's "Total claimed" row renders without a follow-up
    // round trip:
    //   - totalClaimedAmount0 / totalClaimedAmount1: raw token units
    //     (NUMERIC strings to preserve precision); the frontend formats
    //     them with each token's own decimals.
    //   - totalClaimedUsdc: human-dollar headline derived from the
    //     usd_value_micros column the cron writes per event.
    const decorated = rows.map((row) => {
        const totals = claimedByToken.get(row.tokenId);
        return {
            ...row,
            totalClaimedAmount0: totals ? totals.amount0.toString() : "0",
            totalClaimedAmount1: totals ? totals.amount1.toString() : "0",
            totalClaimedUsdc: totals
                ? Number(totals.usdMicros) / 1_000_000
                : 0,
        };
    });
    return NextResponse.json({ positions: decorated });
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

    // Audit C2 anchor: every write path resolves the canonical
    // depositor on chain BEFORE touching the DB. Withdraw is allowed
    // when the position is no longer held by the Compounder (the
    // on-chain withdrawPosition deleted the config — depositor reads
    // as zero — so the DB row stamp is the mirror of a tx that
    // already executed). Upsert always requires the on-chain
    // depositor to match the claimed owner, which closes both the
    // owner-overwrite and the withdraw-anyones-position attacks.
    const onChainDepositor = await readDepositor(body.tokenId);

    if (body.action === "withdraw") {
        // The frontend calls withdraw RIGHT AFTER submitting the
        // on-chain withdrawPosition tx. By the time the DB mirror
        // happens, the contract has either deleted the config
        // (depositor reads as zero) or the tx hasn't mined yet
        // (depositor still points at the caller). We accept both
        // cases — anyone CAN withdraw their own position; nobody
        // CAN withdraw someone else's because the contract refuses
        // any caller who isn't the recorded depositor.
        if (onChainDepositor !== null) {
            // Position is still custodied — only the recorded
            // depositor may stamp `withdrawn_at`. Without this gate a
            // griefer could DoS the cron by enumerating tokenIds and
            // posting withdraws en masse, even though the on-chain
            // NFT never moved.
            if (
                !body.ownerAddress ||
                !isAddress(body.ownerAddress, { strict: false }) ||
                body.ownerAddress.toLowerCase() !==
                    onChainDepositor.toLowerCase()
            ) {
                return NextResponse.json(
                    { error: "Not the position depositor" },
                    { status: 403 },
                );
            }
        }
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
        // The on-chain depositor MUST be defined (position is held
        // by the Compounder) AND match the claimed ownerAddress.
        // Without this gate the API previously let any caller flip
        // `owner_address` via the ON CONFLICT clause and reassign
        // ownership rows for other users — full off-chain ownership
        // takeover even though the NFT custody stayed honest.
        if (
            onChainDepositor === null ||
            body.ownerAddress.toLowerCase() !==
                onChainDepositor.toLowerCase()
        ) {
            return NextResponse.json(
                { error: "Not the position depositor" },
                { status: 403 },
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
