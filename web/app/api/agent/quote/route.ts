import { NextRequest } from "next/server";
import { zeroAddress } from "viem";
import { getSwapPlan, resolveToken } from "@/lib/agent/arcade";
import { ok, bad, preflight, big } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * POST /api/agent/quote { tokenIn, tokenOut, amountIn }
 * Best-execution quote across all Arc venues. Read-only (no calls returned).
 */
export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return bad("invalid json");
    }
    const tokenIn = resolveToken(body.tokenIn);
    const tokenOut = resolveToken(body.tokenOut);
    const amountIn = big(body.amountIn);
    if (!tokenIn || !tokenOut) return bad("tokenIn and tokenOut must be a known symbol or a 0x address");
    if (!amountIn || amountIn === 0n) return bad("amountIn must be a positive integer (raw units)");

    const plan = await getSwapPlan({
        tokenIn,
        tokenOut,
        amountIn,
        recipient: zeroAddress, // placeholder; quote is price-only
        slippageBps: Number(body.slippageBps ?? 50),
    });
    // Price-only: return everything except the executable calls / permit payload.
    const { calls, permit2, nextStep, ...rest } = plan;
    void calls;
    void permit2;
    void nextStep;
    return ok(rest);
}
