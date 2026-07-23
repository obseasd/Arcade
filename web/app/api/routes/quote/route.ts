import { NextRequest, NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { quoteAllRoutes } from "@/lib/routing/aggregate";
import { encodeBigints } from "@/lib/routing/serialize";
import { serverQuoteClient } from "@/lib/serverRpc";
import type { QuoteRequest } from "@/lib/routing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side swap route quoting.
 *
 * The aggregator used to fan out from the browser: 7 providers x several quoter
 * reads each, as individual eth_calls, over the user's own connection. That is
 * where the swap panel's latency lived (a USDC route measured ~20s, and an
 * ad-blocked or throttled RPC made it worse or made it fail outright, which
 * surfaced to the user as a bogus "no route").
 *
 * The same provider code now runs here, against a batching client next to the
 * RPC, and the browser makes ONE request. The client keeps its local fan-out as
 * a fallback, so this route being down degrades speed, never function.
 *
 * Read-only and unauthenticated by design: it signs nothing, moves nothing, and
 * every value it returns is independently re-derived on-chain at execution time
 * (the swap still enforces amountOutMinimum and the deadline). A hostile caller
 * gets what they could already compute from any public RPC.
 */

const MAX_AMOUNT = 2n ** 200n; // absurd-input guard, far above any real balance

function bad(msg: string) {
    return NextResponse.json({ error: msg }, { status: 400 });
}

export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return bad("invalid body");
    }

    const tokenIn = String(body.tokenIn ?? "");
    const tokenOut = String(body.tokenOut ?? "");
    const recipient = String(body.recipient ?? "");
    // strict:false = shape only, no EIP-55 checksum. Callers legitimately send
    // lowercased addresses (the hook's own cache key is lowercased), and a
    // checksum rejection here would read to the user as "no route".
    const addrOk = (a: string) => isAddress(a, { strict: false });
    if (!addrOk(tokenIn) || !addrOk(tokenOut) || !addrOk(recipient)) {
        return bad("tokenIn, tokenOut and recipient must be addresses");
    }

    let amountIn: bigint;
    let deadline: bigint;
    try {
        amountIn = BigInt(String(body.amountIn ?? "0"));
        deadline = BigInt(String(body.deadline ?? "0"));
    } catch {
        return bad("amountIn and deadline must be integer strings");
    }
    if (amountIn <= 0n || amountIn > MAX_AMOUNT) return bad("amountIn out of range");

    const decimalsIn = Number(body.decimalsIn);
    const decimalsOut = Number(body.decimalsOut);
    if (
        !Number.isInteger(decimalsIn) ||
        !Number.isInteger(decimalsOut) ||
        decimalsIn < 0 ||
        decimalsIn > 36 ||
        decimalsOut < 0 ||
        decimalsOut > 36
    ) {
        return bad("decimals out of range");
    }

    const slippageBps = Number(body.slippageBps);
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
        return bad("slippageBps out of range");
    }

    const quoteReq: QuoteRequest = {
        tokenIn: tokenIn as Address,
        tokenOut: tokenOut as Address,
        decimalsIn,
        decimalsOut,
        amountIn,
        recipient: recipient as Address,
        slippageBps,
        // Clamp the deadline server-side. It is baked into executor args, so a
        // caller-supplied far-future value would produce a quote whose on-chain
        // deadline protection is meaningless.
        deadline: (() => {
            const now = BigInt(Math.floor(Date.now() / 1000));
            const max = now + 3_600n;
            if (deadline <= now) return now + 600n;
            return deadline > max ? max : deadline;
        })(),
        // Forward the client's disconnect so an abandoned request stops
        // spending RPC budget mid-fan-out.
        signal: req.signal,
    };

    try {
        const quotes = await quoteAllRoutes(quoteReq, serverQuoteClient());
        // Deliberately uncached: a quote is only valid for the block it was
        // read at, and a POST would not be browser-cached anyway.
        return NextResponse.json({ quotes: encodeBigints(quotes) });
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : "quote failed" },
            { status: 502 },
        );
    }
}
