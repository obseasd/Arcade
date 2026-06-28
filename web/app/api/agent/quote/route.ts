import { NextRequest } from "next/server";
import { zeroAddress } from "viem";
import { getSwapPlan } from "@/lib/agent/arcade";
import { ok, bad, preflight, addr, big } from "@/lib/agent/http";

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
    const tokenIn = addr(body.tokenIn);
    const tokenOut = addr(body.tokenOut);
    const amountIn = big(body.amountIn);
    if (!tokenIn || !tokenOut) return bad("tokenIn and tokenOut must be addresses");
    if (!amountIn || amountIn === 0n) return bad("amountIn must be a positive integer (raw units)");

    const plan = await getSwapPlan({
        tokenIn,
        tokenOut,
        amountIn,
        recipient: zeroAddress, // placeholder; quote is price-only
        slippageBps: Number(body.slippageBps ?? 50),
    });
    return ok({
        ok: plan.ok,
        reason: plan.reason,
        provider: plan.provider,
        amountIn: plan.amountIn,
        amountOut: plan.amountOut,
        executable: plan.executable,
        note: plan.note,
    });
}
