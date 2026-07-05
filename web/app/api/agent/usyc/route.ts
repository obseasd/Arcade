import { NextRequest } from "next/server";
import { getUsycPlan } from "@/lib/agent/arcade";
import { ok, bad, preflight, addr, big } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * POST /api/agent/usyc { action, amountIn, recipient, owner? }
 *  action="deposit": USDC -> USYC (subscribe). amountIn = USDC raw (6dp).
 *  action="redeem":  USYC -> USDC (redeem).   amountIn = USYC raw (6dp).
 *
 * USYC (Hashnote tokenized T-Bills) is a transfer-gated RWA with no AMM pool,
 * so this is the ONLY USDC<->USYC path. Lets an agent park idle USDC into
 * ~4-5% T-Bill yield. Returns contract-call descriptors the agent signs with
 * its own (Hashnote-entitled) Circle Wallet.
 */
export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return bad("invalid json");
    }

    const action = String(body.action ?? "").toLowerCase();
    if (action !== "deposit" && action !== "redeem")
        return bad("action must be one of: deposit, redeem");

    const amountIn = big(body.amountIn);
    if (!amountIn || amountIn === 0n)
        return bad("amountIn must be a positive integer (raw 6-decimal units)");

    const recipient = addr(body.recipient);
    // addr() accepts the zero address (it matches the 0x+40-hex regex); reject
    // it here so a deposit can't mint USYC shares to 0x0 (burning the USDC).
    if (!recipient || /^0x0{40}$/i.test(recipient))
        return bad("recipient must be a non-zero address");

    const owner = addr(body.owner) ?? undefined;
    if (owner && /^0x0{40}$/i.test(owner)) return bad("owner must be a non-zero address");

    return ok(
        await getUsycPlan({
            action: action as "deposit" | "redeem",
            amountIn,
            recipient,
            owner,
        }),
    );
}
