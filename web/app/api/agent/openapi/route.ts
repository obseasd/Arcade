import { NextRequest } from "next/server";
import { ok, preflight } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** GET /api/agent/openapi — OpenAPI 3.1 spec so agents can auto-discover the
 *  Arcade agent tools. Server URL is derived from the request origin. */
export async function GET(req: NextRequest) {
    const origin = req.nextUrl.origin;
    return ok({
        openapi: "3.1.0",
        info: {
            title: "Arcade Agent API",
            version: "1.0.0",
            description:
                "Lets any AI agent use Arcade (a USDC-native DEX + bonding-curve launchpad on Circle's Arc L1). Read endpoints return market data; build endpoints return ordered contract-call descriptors { contractAddress, abiFunctionSignature, abiParameters } that map 1:1 onto Circle createContractExecutionTransaction. The agent signs with its OWN wallet; Arcade never custodies keys. USDC is the native gas token on Arc, so an agent only needs USDC.",
        },
        servers: [{ url: `${origin}/api/agent` }],
        paths: {
            "/markets": { get: { summary: "Reference tradeable tokens", responses: { "200": { description: "ok" } } } },
            "/trending": {
                get: {
                    summary: "Launchpad tokens by market cap",
                    parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 15 } }],
                    responses: { "200": { description: "ok" } },
                },
            },
            "/portfolio": {
                get: {
                    summary: "Known-token balances for a wallet",
                    parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }],
                    responses: { "200": { description: "ok" } },
                },
            },
            "/quote": {
                post: {
                    summary: "Best-execution price quote (read-only)",
                    requestBody: {
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    required: ["tokenIn", "tokenOut", "amountIn"],
                                    properties: {
                                        tokenIn: { type: "string" },
                                        tokenOut: { type: "string" },
                                        amountIn: { type: "string", description: "raw units" },
                                        slippageBps: { type: "integer", default: 50 },
                                    },
                                },
                            },
                        },
                    },
                    responses: { "200": { description: "ok" } },
                },
            },
            "/swap": {
                post: {
                    summary: "Build approve + swap descriptors for the agent to sign",
                    requestBody: {
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    required: ["tokenIn", "tokenOut", "amountIn", "recipient"],
                                    properties: {
                                        tokenIn: { type: "string" },
                                        tokenOut: { type: "string" },
                                        amountIn: { type: "string" },
                                        recipient: { type: "string", description: "the agent wallet" },
                                        slippageBps: { type: "integer", default: 50 },
                                    },
                                },
                            },
                        },
                    },
                    responses: { "200": { description: "ok" } },
                },
            },
            "/launchpad": {
                post: {
                    summary: "Build bonding-curve buy/sell or create-token descriptors",
                    requestBody: {
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    required: ["action"],
                                    properties: {
                                        action: { type: "string", enum: ["buy", "sell", "create"] },
                                        token: { type: "string" },
                                        amountUsdcIn: { type: "string" },
                                        tokensIn: { type: "string" },
                                        name: { type: "string" },
                                        symbol: { type: "string" },
                                        metadataURI: { type: "string" },
                                        mode: { type: "integer", description: "0=PUMP, 1=CLANKER, 2=CLANKER_V3" },
                                        slippageBps: { type: "integer", default: 100 },
                                    },
                                },
                            },
                        },
                    },
                    responses: { "200": { description: "ok" } },
                },
            },
            "/multiswap": {
                post: {
                    summary: "Converge a basket of tokens into one output (aggregator)",
                    requestBody: {
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    required: ["inputs", "tokenOut"],
                                    properties: {
                                        inputs: {
                                            type: "array",
                                            items: {
                                                type: "object",
                                                properties: { token: { type: "string" }, amount: { type: "string" } },
                                            },
                                        },
                                        tokenOut: { type: "string" },
                                        minTotalOut: { type: "string", default: "0" },
                                    },
                                },
                            },
                        },
                    },
                    responses: { "200": { description: "ok" } },
                },
            },
        },
    });
}
