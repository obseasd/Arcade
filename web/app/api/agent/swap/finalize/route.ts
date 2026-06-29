import { NextRequest } from "next/server";
import { finalizePermit2Swap, resolveToken } from "@/lib/agent/arcade";
import { ok, bad, preflight, addr, big } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * POST /api/agent/swap/finalize
 * { tokenIn, tokenOut, amountIn, recipient, slippageBps?, permit, signature }
 *
 * Step 2 of a Permit2 swap. After /api/agent/swap returned a Permit2 signature
 * request, the agent signs `permit2.typedData` with its wallet (Circle
 * sign/typedData) and posts the resulting `signature` plus the echoed
 * `permit2.permit` here. Returns the final execute() contract-call descriptor.
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
    const recipient = addr(body.recipient);
    const amountIn = big(body.amountIn);
    const signature = body.signature;
    const permit = body.permit;
    if (!tokenIn || !tokenOut) return bad("tokenIn and tokenOut must be addresses");
    if (!recipient) return bad("recipient (the agent wallet) must be an address");
    if (!amountIn || amountIn === 0n) return bad("amountIn must be a positive integer");
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature))
        return bad("signature must be a hex string");
    if (!permit || typeof permit !== "object") return bad("permit (echoed from /swap) is required");

    const plan = await finalizePermit2Swap({
        tokenIn,
        tokenOut,
        amountIn,
        recipient,
        slippageBps: Number(body.slippageBps ?? 50),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        permit: permit as any,
        signature: signature as `0x${string}`,
    });
    return ok(plan);
}
