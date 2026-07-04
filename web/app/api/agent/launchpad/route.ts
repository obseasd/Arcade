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
            await getLaunchpadBuyPlan({
                token,
                amountUsdcIn,
                slippageBps: Number(body.slippageBps ?? 100),
                owner: addr(body.owner) ?? undefined,
            }),
        );
    }
    if (action === "sell") {
        const token = addr(body.token);
        const tokensIn = big(body.tokensIn);
        if (!token) return bad("token must be an address");
        if (!tokensIn || tokensIn === 0n) return bad("tokensIn must be a positive integer");
        return ok(
            await getLaunchpadSellPlan({
                token,
                tokensIn,
                slippageBps: Number(body.slippageBps ?? 100),
                owner: addr(body.owner) ?? undefined,
            }),
        );
    }
    if (action === "create") {
        const name = String(body.name ?? "");
        const symbol = String(body.symbol ?? "");
        if (!name || !symbol) return bad("name and symbol are required");
        // Accept the numeric mode (0/1/2) OR the case-insensitive string enum
        // (PUMP/CLANKER/CLANKER_V3). Agents naturally pass the name, so
        // rejecting the string was an agent-usability foot-gun.
        const MODE_BY_NAME: Record<string, number> = { pump: 0, clanker: 1, clanker_v3: 2, clankerv3: 2 };
        let mode = 0;
        if (body.mode !== undefined) {
            if (typeof body.mode === "string" && MODE_BY_NAME[body.mode.trim().toLowerCase()] !== undefined) {
                mode = MODE_BY_NAME[body.mode.trim().toLowerCase()];
            } else {
                mode = Number(body.mode);
            }
        }
        if (![0, 1, 2].includes(mode))
            return bad("mode must be 0/1/2 or PUMP/CLANKER/CLANKER_V3");
        const creator2 = addr(body.creator2) ?? undefined;
        const creator2ShareBps =
            body.creator2ShareBps !== undefined ? Number(body.creator2ShareBps) : undefined;
        if (creator2ShareBps !== undefined && (creator2ShareBps < 0 || creator2ShareBps > 10_000))
            return bad("creator2ShareBps must be between 0 and 10000");
        if (creator2ShareBps && !creator2) return bad("creator2 address is required when creator2ShareBps is set");
        return ok(
            getCreateTokenPlan({
                name,
                symbol,
                metadataURI: body.metadataURI ? String(body.metadataURI) : undefined,
                mode,
                creator2,
                creator2ShareBps,
            }),
        );
    }
    return bad("action must be one of: buy, sell, create");
}
