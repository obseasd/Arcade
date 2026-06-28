import { NextRequest } from "next/server";
import { getMultiswapPlan } from "@/lib/agent/arcade";
import { ok, bad, preflight, addr, big } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * POST /api/agent/multiswap { inputs: [{token, amount}], tokenOut, minTotalOut? }
 * Converges a basket of input tokens into one output token in a single
 * settlement (Arcade's aggregator). Returns approve + swapToSingle descriptors.
 */
export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return bad("invalid json");
    }
    const tokenOut = addr(body.tokenOut);
    if (!tokenOut) return bad("tokenOut must be an address");
    if (!Array.isArray(body.inputs) || body.inputs.length === 0) return bad("inputs must be a non-empty array");

    const inputs: { token: `0x${string}`; amount: bigint }[] = [];
    for (const raw of body.inputs as unknown[]) {
        const o = raw as Record<string, unknown>;
        const token = addr(o.token);
        const amount = big(o.amount);
        if (!token || !amount || amount === 0n) return bad("each input needs { token: address, amount: positive int }");
        inputs.push({ token, amount });
    }
    const minTotalOut = big(body.minTotalOut) ?? 0n;
    return ok(getMultiswapPlan({ inputs, tokenOut, minTotalOut }));
}
