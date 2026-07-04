import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP-over-HTTP endpoint (streamable HTTP, stateless JSON-RPC). Lets agents and
 * directories (Smithery, etc.) and HTTP-MCP clients use Arcade WITHOUT
 * installing anything — just point them at https://www.arcade.trading/api/agent/mcp.
 * Each tool call proxies the same-origin REST agent API.
 */

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Mcp-Session-Id",
};
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: CORS });

const sym = "A known symbol (USDC, USDT, EURC, WUSDC, cirBTC, WETH) or a 0x token address.";
const raw = "Amount in RAW integer token units (e.g. 1 USDC = \"1000000\"; USDC has 6 decimals).";
const RO = { readOnlyHint: true, openWorldHint: true };
const WR = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const TOOLS = [
    {
        name: "arcade_markets",
        description: "List always-tradeable reference tokens on Arc (symbol, address, decimals).",
        inputSchema: { type: "object", properties: {} },
        annotations: { title: "List markets", ...RO },
    },
    {
        name: "arcade_trending",
        description: "List launchpad tokens ranked by market cap, with price, curve progress and tradeVia (launchpad|swap).",
        inputSchema: {
            type: "object",
            properties: { limit: { type: "integer", description: "Max tokens to return (1-30, default 15)." } },
        },
        annotations: { title: "Trending launchpad tokens", ...RO },
    },
    {
        name: "arcade_portfolio",
        description: "Known-token balances and their USDC valuation for a wallet, plus a total.",
        inputSchema: {
            type: "object",
            properties: { wallet: { type: "string", description: "The 0x wallet address to inspect." } },
            required: ["wallet"],
        },
        annotations: { title: "Wallet portfolio", ...RO },
    },
    {
        name: "arcade_quote",
        description: "Best-execution price quote across all Arc venues. Read-only; returns amountOut, minAmountOut, effectivePrice and a priceWarning on bad fills.",
        inputSchema: {
            type: "object",
            properties: {
                tokenIn: { type: "string", description: sym },
                tokenOut: { type: "string", description: sym },
                amountIn: { type: "string", description: raw },
                slippageBps: { type: "integer", description: "Slippage tolerance in basis points (default 50 = 0.5%)." },
            },
            required: ["tokenIn", "tokenOut", "amountIn"],
        },
        annotations: { title: "Quote a swap", ...RO },
    },
    {
        name: "arcade_swap",
        description: "Build ordered approve + swap contract-call descriptors for the agent to sign with its own Circle Wallet. Run calls[] in order.",
        inputSchema: {
            type: "object",
            properties: {
                tokenIn: { type: "string", description: sym },
                tokenOut: { type: "string", description: sym },
                amountIn: { type: "string", description: raw },
                recipient: { type: "string", description: "The agent's wallet address; swap output is sent here." },
                slippageBps: { type: "integer", description: "Slippage tolerance in basis points (default 50)." },
            },
            required: ["tokenIn", "tokenOut", "amountIn", "recipient"],
        },
        annotations: { title: "Build a swap", ...WR },
    },
    {
        name: "arcade_swap_finalize",
        description: "Permit2 step 2: after signing permit2.typedData from arcade_swap, inject the signature and return the executable call.",
        inputSchema: {
            type: "object",
            properties: {
                tokenIn: { type: "string", description: sym },
                tokenOut: { type: "string", description: sym },
                amountIn: { type: "string", description: raw },
                recipient: { type: "string", description: "The agent's wallet address." },
                permit: { type: "object", description: "The permit2.permit object echoed from arcade_swap." },
                signature: { type: "string", description: "EIP-712 signature of permit2.typedData (hex)." },
                slippageBps: { type: "integer", description: "Slippage tolerance in basis points (default 50)." },
            },
            required: ["tokenIn", "tokenOut", "amountIn", "recipient", "permit", "signature"],
        },
        annotations: { title: "Finalize a Permit2 swap", ...WR },
    },
    {
        name: "arcade_launchpad",
        description: "Build bonding-curve buy/sell or create-token descriptors for the agent to sign.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["buy", "sell", "create"], description: "buy or sell a curve token, or create a new launch." },
                token: { type: "string", description: "The 0x launchpad token address (for buy/sell)." },
                amountUsdcIn: { type: "string", description: "USDC to spend on a buy, RAW units (6 decimals)." },
                tokensIn: { type: "string", description: "Tokens to sell, RAW units (18 decimals)." },
                name: { type: "string", description: "Token name (for create)." },
                symbol: { type: "string", description: "Token symbol (for create)." },
                metadataURI: { type: "string", description: "Optional metadata URI (for create)." },
                mode: { type: "integer", description: "0=PUMP, 1=CLANKER, 2=CLANKER_V3 (for create)." },
                owner: { type: "string", description: "Optional: the agent wallet, to skip a redundant approve if already allowed." },
                slippageBps: { type: "integer", description: "Slippage tolerance in basis points (default 100)." },
            },
            required: ["action"],
        },
        annotations: { title: "Launchpad buy/sell/create", ...WR },
    },
    {
        name: "arcade_usyc",
        description: "Park idle USDC into USYC (Hashnote tokenized US T-Bills, ~4-5% yield) or redeem it back. USYC is a transfer-gated RWA with no AMM pool; this Teller (deposit/redeem) is the only USDC<->USYC path. The wallet must be Hashnote-entitled. Run calls[] in order.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["deposit", "redeem"], description: "deposit = USDC->USYC (subscribe); redeem = USYC->USDC." },
                amountIn: { type: "string", description: "RAW 6-decimal units: USDC for deposit, USYC for redeem." },
                recipient: { type: "string", description: "The agent's wallet address; the output token is sent here." },
                owner: { type: "string", description: "Optional: defaults to recipient. Redeem burns this owner's USYC shares." },
            },
            required: ["action", "amountIn", "recipient"],
        },
        annotations: { title: "USYC subscribe/redeem", ...WR },
    },
    {
        name: "arcade_multiswap",
        description: "Build a basket-converge swap: many input tokens into one output token in a single settlement (Arcade aggregator).",
        inputSchema: {
            type: "object",
            properties: {
                inputs: {
                    type: "array",
                    description: "Input tokens to converge.",
                    items: {
                        type: "object",
                        properties: {
                            token: { type: "string", description: sym },
                            amount: { type: "string", description: raw },
                        },
                    },
                },
                tokenOut: { type: "string", description: sym },
                minTotalOut: { type: "string", description: "Optional explicit slippage floor (RAW units); otherwise computed." },
                owner: { type: "string", description: "Optional: the agent wallet, to skip redundant approves." },
            },
            required: ["inputs", "tokenOut"],
        },
        annotations: { title: "Multi-input converge swap", ...WR },
    },
];

const RESOURCES = [
    { uri: "https://www.arcade.trading/api/agent/openapi", name: "Arcade Agent OpenAPI", mimeType: "application/json", description: "OpenAPI 3.1 spec for all Arcade agent endpoints." },
    { uri: "https://www.arcade.trading/agents", name: "Arcade Agent docs", mimeType: "text/html", description: "How an agent discovers and uses Arcade." },
];

function toRequest(name: string, args: Record<string, unknown>, base: string): { url: string; init: RequestInit } | null {
    const a = args ?? {};
    const post = (path: string) => ({ url: `${base}${path}`, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) } });
    switch (name) {
        case "arcade_markets":
            return { url: `${base}/markets`, init: {} };
        case "arcade_trending":
            return { url: `${base}/trending?limit=${Number(a.limit ?? 15)}`, init: {} };
        case "arcade_portfolio":
            return { url: `${base}/portfolio?wallet=${encodeURIComponent(String(a.wallet ?? ""))}`, init: {} };
        case "arcade_quote":
            return post("/quote");
        case "arcade_swap":
            return post("/swap");
        case "arcade_swap_finalize":
            return post("/swap/finalize");
        case "arcade_launchpad":
            return post("/launchpad");
        case "arcade_usyc":
            return post("/usyc");
        case "arcade_multiswap":
            return post("/multiswap");
        default:
            return null;
    }
}

export function OPTIONS() {
    return new NextResponse(null, { headers: CORS });
}

// Some clients probe with GET; advertise this is a POST JSON-RPC endpoint.
export function GET() {
    return json({ name: "arcade-agent", transport: "streamable-http", hint: "POST JSON-RPC 2.0 here (initialize, tools/list, tools/call)." });
}

export async function POST(req: NextRequest) {
    const base = `${req.nextUrl.origin}/api/agent`;
    let body: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
        body = await req.json();
    } catch {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    const { id, method, params } = body;

    if (method === "initialize") {
        return json({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {}, resources: {}, prompts: {} },
                serverInfo: { name: "arcade-agent", version: "1.0.0" },
            },
        });
    }
    if (method && method.startsWith("notifications/")) {
        return new NextResponse(null, { status: 202, headers: CORS });
    }
    if (method === "tools/list") {
        return json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }
    if (method === "resources/list") {
        return json({ jsonrpc: "2.0", id, result: { resources: RESOURCES } });
    }
    if (method === "resources/read") {
        const uri = String(params?.uri ?? "");
        if (!RESOURCES.some((r) => r.uri === uri)) {
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown resource: ${uri}` } });
        }
        try {
            const res = await fetch(uri);
            const text = await res.text();
            return json({ jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "text/plain", text }] } });
        } catch {
            return json({ jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "text/plain", text: "" }] } });
        }
    }
    if (method === "prompts/list") {
        return json({ jsonrpc: "2.0", id, result: { prompts: [] } });
    }
    if (method === "tools/call") {
        const name = String(params?.name ?? "");
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        const r = toRequest(name, args, base);
        if (!r) {
            return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true } });
        }
        try {
            const res = await fetch(r.url, r.init);
            const text = await res.text();
            return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: !res.ok } });
        } catch (e) {
            return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true } });
        }
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}
