import { NextRequest } from "next/server";
import { getSwapPlan } from "@/lib/agent/arcade";
import { ok, bad, preflight, addr, big } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * POST /api/agent/swap { tokenIn, tokenOut, amountIn, recipient, slippageBps? }
 * Returns ordered contract-call descriptors (approve + swap) for the agent to
 * sign with its own wallet (e.g. Circle createContractExecutionTransaction).
 * `recipient` is the agent's wallet; swap output is sent there.
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
    const recipient = addr(body.recipient);
    const amountIn = big(body.amountIn);
    if (!tokenIn || !tokenOut) return bad("tokenIn and tokenOut must be addresses");
    if (!recipient) return bad("recipient (the agent wallet) must be an address");
    if (!amountIn || amountIn === 0n) return bad("amountIn must be a positive integer (raw units)");

    const plan = await getSwapPlan({
        tokenIn,
        tokenOut,
        amountIn,
        recipient,
        slippageBps: Number(body.slippageBps ?? 50),
    });
    return ok(plan);
}
