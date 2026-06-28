#!/usr/bin/env node
/**
 * Smoke-test the Arcade Agent API. No jq / curl needed (uses Node fetch).
 *   node scripts/test-agent-api.mjs                 (defaults to localhost:3000)
 *   ARCADE_API_BASE=https://www.arcade.trading node scripts/test-agent-api.mjs
 */
const BASE = (process.env.ARCADE_API_BASE || "http://localhost:3000") + "/api/agent";
const RECIPIENT = "0x3a0Dd90212838f32a953Acd4B32596b62859324A"; // testnet EOA, build-only

const j = (o) => JSON.stringify(o);
function show(label, status, body) {
    console.log(`\n=== ${label}  [${status}] ===`);
    console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}
async function get(path) {
    const r = await fetch(`${BASE}${path}`);
    const b = await r.json().catch(() => "(non-json)");
    return { status: r.status, body: b };
}
async function post(path, body) {
    const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: j(body),
    });
    const b = await r.json().catch(() => "(non-json)");
    return { status: r.status, body: b };
}

async function main() {
    console.log(`Testing ${BASE}`);

    // 1. markets
    const markets = await get("/markets");
    show("GET /markets", markets.status, markets.body);
    const usdc = markets.body?.tokens?.find((t) => t.symbol === "USDC")?.address;
    if (!usdc) return console.error("\nNo USDC in markets — check NEXT_PUBLIC_USDC_ADDRESS env. Stopping.");

    // 2. trending
    const trending = await get("/trending?limit=5");
    show("GET /trending?limit=5", trending.status, trending.body);
    const token = trending.body?.tokens?.[0]?.token;

    // 3. quote (USDC -> token), 1 USDC
    if (token) {
        const quote = await post("/quote", { tokenIn: usdc, tokenOut: token, amountIn: "1000000" });
        show("POST /quote (1 USDC -> token)", quote.status, quote.body);

        // 4. build swap
        const swap = await post("/swap", {
            tokenIn: usdc,
            tokenOut: token,
            amountIn: "1000000",
            recipient: RECIPIENT,
        });
        show("POST /swap", swap.status, swap.body);

        // 5. launchpad buy (1 USDC)
        const buy = await post("/launchpad", { action: "buy", token, amountUsdcIn: "1000000" });
        show("POST /launchpad buy", buy.status, buy.body);
    } else {
        console.log("\n(no launchpad token found — skipping quote/swap/buy against a launch token)");
    }

    // 6. portfolio
    const pf = await get(`/portfolio?wallet=${RECIPIENT}`);
    show("GET /portfolio", pf.status, pf.body);

    // 7. openapi (paths only)
    const oa = await get("/openapi");
    show("GET /openapi (paths)", oa.status, oa.body?.paths ? Object.keys(oa.body.paths) : oa.body);

    console.log("\nDone. Look for: markets/trending listing tokens, quote with amountOut, swap+buy returning calls[] (approve + action) with abiFunctionSignature.");
}
main().catch((e) => console.error("FAILED:", e));
