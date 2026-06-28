#!/usr/bin/env node
/**
 * Arcade Agent MCP server.
 *
 * Exposes Arcade (a USDC-native DEX + bonding-curve launchpad on Circle's Arc
 * L1) as MCP tools so any MCP-capable agent (Claude, etc.) can discover
 * markets, quote, and BUILD ready-to-sign transactions. The agent signs the
 * returned descriptors with its OWN wallet (e.g. a Circle developer-controlled
 * wallet via createContractExecutionTransaction). This server never holds keys
 * and never signs; it is a thin wrapper over the Arcade agent REST API.
 *
 * Config: ARCADE_API_BASE (default https://www.arcade.trading).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.ARCADE_API_BASE || "https://www.arcade.trading";

async function api(path, init) {
    const res = await fetch(`${BASE}/api/agent${path}`, init);
    return res.text();
}
const post = (body) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
});
const out = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s) }] });

const server = new McpServer({ name: "arcade-agent", version: "1.0.0" });

server.tool(
    "arcade_markets",
    "List always-tradeable reference tokens on Arc (USDC, stablecoins, BTC, ETH).",
    {},
    async () => out(await api("/markets")),
);

server.tool(
    "arcade_trending",
    "List launchpad tokens ranked by market cap (USDC), with curve progress.",
    { limit: z.number().int().min(1).max(30).optional() },
    async ({ limit }) => out(await api(`/trending?limit=${limit ?? 15}`)),
);

server.tool(
    "arcade_portfolio",
    "Get known-token balances for a wallet address.",
    { wallet: z.string() },
    async ({ wallet }) => out(await api(`/portfolio?wallet=${wallet}`)),
);

server.tool(
    "arcade_quote",
    "Best-execution price quote across all Arc venues. Read-only. amountIn is in raw token units.",
    {
        tokenIn: z.string(),
        tokenOut: z.string(),
        amountIn: z.string(),
        slippageBps: z.number().optional(),
    },
    async (a) => out(await api("/quote", post(a))),
);

server.tool(
    "arcade_swap",
    "Build approve + swap contract-call descriptors (contractAddress, abiFunctionSignature, abiParameters) for the agent to sign with its own wallet. recipient is the agent wallet; output is sent there.",
    {
        tokenIn: z.string(),
        tokenOut: z.string(),
        amountIn: z.string(),
        recipient: z.string(),
        slippageBps: z.number().optional(),
    },
    async (a) => out(await api("/swap", post(a))),
);

server.tool(
    "arcade_swap_finalize",
    "Permit2 step 2: after signing the typedData from arcade_swap (Circle sign/typedData), inject the signature and get the execute() call. Pass the same swap params plus the echoed permit and the signature.",
    {
        tokenIn: z.string(),
        tokenOut: z.string(),
        amountIn: z.string(),
        recipient: z.string(),
        slippageBps: z.number().optional(),
        permit: z.any(),
        signature: z.string(),
    },
    async (a) => out(await api("/swap/finalize", post(a))),
);

server.tool(
    "arcade_launchpad",
    "Build bonding-curve buy/sell or create-token descriptors. action='buy' {token, amountUsdcIn}; action='sell' {token, tokensIn}; action='create' {name, symbol, metadataURI?, mode?}.",
    {
        action: z.enum(["buy", "sell", "create"]),
        token: z.string().optional(),
        amountUsdcIn: z.string().optional(),
        tokensIn: z.string().optional(),
        name: z.string().optional(),
        symbol: z.string().optional(),
        metadataURI: z.string().optional(),
        mode: z.number().optional(),
        slippageBps: z.number().optional(),
    },
    async (a) => out(await api("/launchpad", post(a))),
);

server.tool(
    "arcade_multiswap",
    "Build a basket-converge swap (Arcade aggregator): many input tokens into one output token in a single settlement.",
    {
        inputs: z.array(z.object({ token: z.string(), amount: z.string() })),
        tokenOut: z.string(),
        minTotalOut: z.string().optional(),
    },
    async (a) => out(await api("/multiswap", post(a))),
);

const transport = new StdioServerTransport();
await server.connect(transport);
