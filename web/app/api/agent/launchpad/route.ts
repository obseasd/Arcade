import { NextRequest } from "next/server";
import {
    getLaunchpadBuyPlan,
    getLaunchpadSellPlan,
    getCreateTokenPlan,
} from "@/lib/agent/arcade";
import { ok, bad, preflight, addr, big } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * POST /api/agent/launchpad { action, ... }
 *  action="buy":    { token, amountUsdcIn, slippageBps? }  bonding-curve buy
 *  action="sell":   { token, tokensIn, slippageBps? }      bonding-curve sell
 *  action="create": { name, symbol, metadataURI?, mode?, creator2?, creator2ShareBps? }
 * Returns contract-call descriptors for the agent to sign.
 */
export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return bad("invalid json");
    }
    const action = String(body.action ?? "");

    if (action === "buy") {
        const token = addr(body.token);
        const amountUsdcIn = big(body.amountUsdcIn);
        if (!token) return bad("token must be an address");
        if (!amountUsdcIn || amountUsdcIn === 0n) return bad("amountUsdcIn must be a positive integer");
        return ok(
            await getLaunchpadBuyPlan({ token, amountUsdcIn, slippageBps: Number(body.slippageBps ?? 100) }),
        );
    }
    if (action === "sell") {
        const token = addr(body.token);
        const tokensIn = big(body.tokensIn);
        if (!token) return bad("token must be an address");
        if (!tokensIn || tokensIn === 0n) return bad("tokensIn must be a positive integer");
        return ok(
            await getLaunchpadSellPlan({ token, tokensIn, slippageBps: Number(body.slippageBps ?? 100) }),
        );
    }
    if (action === "create") {
        const name = String(body.name ?? "");
        const symbol = String(body.symbol ?? "");
        if (!name || !symbol) return bad("name and symbol are required");
        const creator2 = addr(body.creator2) ?? undefined;
        return ok(
            getCreateTokenPlan({
                name,
                symbol,
                metadataURI: body.metadataURI ? String(body.metadataURI) : undefined,
                mode: body.mode !== undefined ? Number(body.mode) : undefined,
                creator2,
                creator2ShareBps:
                    body.creator2ShareBps !== undefined ? Number(body.creator2ShareBps) : undefined,
            }),
        );
    }
    return bad("action must be one of: buy, sell, create");
}
