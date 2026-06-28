import { listKnownMarkets } from "@/lib/agent/arcade";
import { ok, preflight } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** GET /api/agent/markets — always-tradeable reference tokens on Arc. */
export async function GET() {
    return ok({
        chain: "ARC-TESTNET",
        tokens: await listKnownMarkets(),
        hints: {
            launchpadTokens: "GET /api/agent/trending",
            pricing: "POST /api/agent/quote { tokenIn, tokenOut, amountIn }",
        },
    });
}
