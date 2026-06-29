import { NextRequest } from "next/server";
import { getMultiswapPlan, resolveToken } from "@/lib/agent/arcade";
import { ok, bad, preflight, big } from "@/lib/agent/http";

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
    const tokenOut = resolveToken(body.tokenOut);
    if (!tokenOut) return bad("tokenOut must be a known symbol or a 0x address");
    if (!Array.isArray(body.inputs) || body.inputs.length === 0) return bad("inputs must be a non-empty array");

    const inputs: { token: `0x${string}`; amount: bigint }[] = [];
    for (const raw of body.inputs as unknown[]) {
        const o = raw as Record<string, unknown>;
        const token = resolveToken(o.token);
        const amount = big(o.amount);
        if (!token || !amount || amount === 0n) return bad("each input needs { token: symbol|address, amount: positive int }");
        inputs.push({ token, amount });
    }
    // Leave minTotalOut undefined so the lib computes a real slippage floor;
    // only honor an explicit caller value.
    const minTotalOut = body.minTotalOut !== undefined ? (big(body.minTotalOut) ?? undefined) : undefined;
    return ok(
        await getMultiswapPlan({
            inputs,
            tokenOut,
            minTotalOut,
            slippageBps: Number(body.slippageBps ?? 100),
        }),
    );
}
