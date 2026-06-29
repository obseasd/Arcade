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

const TOOLS = [
    {
        name: "arcade_markets",
        description: "List always-tradeable reference tokens on Arc.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "arcade_trending",
        description: "List launchpad tokens by market cap (with price, curve progress, tradeVia).",
        inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    {
        name: "arcade_portfolio",
        description: "Known-token balances + USDC valuation for a wallet.",
        inputSchema: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] },
    },
    {
        name: "arcade_quote",
        description: "Best-execution price quote. Amounts are RAW token units; tokenIn/tokenOut accept a symbol or 0x address.",
        inputSchema: {
            type: "object",
            properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" }, slippageBps: { type: "integer" } },
            required: ["tokenIn", "tokenOut", "amountIn"],
        },
    },
    {
        name: "arcade_swap",
        description: "Build approve + swap contract-call descriptors for the agent to sign with its own Circle Wallet. recipient is the agent wallet.",
        inputSchema: {
            type: "object",
            properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" }, recipient: { type: "string" }, slippageBps: { type: "integer" } },
            required: ["tokenIn", "tokenOut", "amountIn", "recipient"],
        },
    },
    {
        name: "arcade_swap_finalize",
        description: "Permit2 step 2: inject the signature and return the execute() call.",
        inputSchema: {
            type: "object",
            properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" }, recipient: { type: "string" }, permit: { type: "object" }, signature: { type: "string" }, slippageBps: { type: "integer" } },
            required: ["tokenIn", "tokenOut", "amountIn", "recipient", "permit", "signature"],
        },
    },
    {
        name: "arcade_launchpad",
        description: "Build bonding-curve buy/sell or create-token descriptors. action: buy|sell|create.",
        inputSchema: {
            type: "object",
            properties: { action: { type: "string", enum: ["buy", "sell", "create"] }, token: { type: "string" }, amountUsdcIn: { type: "string" }, tokensIn: { type: "string" }, name: { type: "string" }, symbol: { type: "string" }, metadataURI: { type: "string" }, mode: { type: "integer" }, owner: { type: "string" }, slippageBps: { type: "integer" } },
            required: ["action"],
        },
    },
    {
        name: "arcade_multiswap",
        description: "Build a basket-converge swap: many input tokens into one output token in one settlement.",
        inputSchema: {
            type: "object",
            properties: { inputs: { type: "array", items: { type: "object", properties: { token: { type: "string" }, amount: { type: "string" } } } }, tokenOut: { type: "string" }, minTotalOut: { type: "string" }, owner: { type: "string" } },
            required: ["inputs", "tokenOut"],
        },
    },
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
                capabilities: { tools: {} },
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
