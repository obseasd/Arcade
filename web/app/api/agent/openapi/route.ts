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
                    responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { tokens: { type: "array", items: { $ref: "#/components/schemas/TrendingToken" } } } } } } } },
                },
            },
            "/portfolio": {
                get: {
                    summary: "Known-token balances for a wallet (valued in USDC)",
                    parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }],
                    responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Portfolio" } } } } },
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
            "/swap/finalize": {
                post: {
                    summary: "Permit2 step 2: inject the signature and return the execute call",
                    requestBody: {
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    required: ["tokenIn", "tokenOut", "amountIn", "recipient", "permit", "signature"],
                                    properties: {
                                        tokenIn: { type: "string" },
                                        tokenOut: { type: "string" },
                                        amountIn: { type: "string" },
                                        recipient: { type: "string" },
                                        slippageBps: { type: "integer", default: 50 },
                                        permit: { type: "object", description: "echoed from /swap permit2.permit" },
                                        signature: { type: "string", description: "EIP-712 signature of permit2.typedData" },
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
            "/usyc": {
                post: {
                    summary: "Subscribe/redeem USYC (Hashnote tokenized T-Bills) for ~4-5% yield on idle USDC",
                    description:
                        "USYC is a transfer-gated RWA with no AMM pool; the Hashnote ERC-4626 Teller is the only USDC<->USYC path. deposit = USDC->USYC (subscribe), redeem = USYC->USDC. The wallet must be Hashnote-entitled or the Teller reverts.",
                    requestBody: {
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    required: ["action", "amountIn", "recipient"],
                                    properties: {
                                        action: { type: "string", enum: ["deposit", "redeem"] },
                                        amountIn: { type: "string", description: "raw 6-decimal units (USDC for deposit, USYC for redeem)" },
                                        recipient: { type: "string", description: "the agent wallet receiving the output token" },
                                        owner: { type: "string", description: "optional; defaults to recipient (redeem burns owner's shares)" },
                                    },
                                },
                            },
                        },
                    },
                    responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/BuildPlan" } } } } },
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
                    responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/BuildPlan" } } } } },
                },
            },
        },
        components: {
            schemas: {
                Error: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", example: false },
                        error: { type: "string" },
                        code: { type: "string", description: "BAD_REQUEST | NO_ROUTE | NO_CURVE | GRADUATED | READ_FAILED | QUOTE_FAILED" },
                        retryable: { type: "boolean" },
                    },
                },
                ContractCall: {
                    type: "object",
                    description: "Maps 1:1 onto Circle createContractExecutionTransaction.",
                    properties: {
                        chain: { type: "string", example: "ARC-TESTNET" },
                        contractAddress: { type: "string" },
                        abiFunctionSignature: { type: "string", example: "approve(address,uint256)" },
                        abiParameters: { type: "array", items: {} },
                        value: { type: "string", description: "native value (USDC raw units), usually 0" },
                        description: { type: "string" },
                    },
                },
                BuildPlan: {
                    type: "object",
                    description: "Returned by /swap, /launchpad, /multiswap, /swap/finalize.",
                    properties: {
                        ok: { type: "boolean" },
                        provider: { type: "string" },
                        amountIn: { type: "string" },
                        amountInFmt: { type: "string" },
                        amountOut: { type: "string" },
                        amountOutFmt: { type: "string" },
                        minAmountOut: { type: "string", description: "slippage floor (raw units)" },
                        slippageBps: { type: "integer" },
                        tokenIn: { type: "object", properties: { address: { type: "string" }, symbol: { type: "string" }, decimals: { type: "integer" } } },
                        tokenOut: { type: "object", properties: { address: { type: "string" }, symbol: { type: "string" }, decimals: { type: "integer" } } },
                        executable: { type: "boolean" },
                        requiresPermit2Signature: { type: "boolean" },
                        permit2: { type: "object", properties: { approve: { $ref: "#/components/schemas/ContractCall" }, typedData: { type: "object" }, permit: { type: "object" }, finalize: { type: "string" } } },
                        nextStep: { type: "string" },
                        calls: { type: "array", items: { $ref: "#/components/schemas/ContractCall" } },
                    },
                },
                Quote: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        provider: { type: "string" },
                        amountIn: { type: "string" },
                        amountInFmt: { type: "string" },
                        amountOut: { type: "string" },
                        amountOutFmt: { type: "string" },
                        minAmountOut: { type: "string" },
                        slippageBps: { type: "integer" },
                        executable: { type: "boolean" },
                        requiresPermit2Signature: { type: "boolean" },
                    },
                },
                TrendingToken: {
                    type: "object",
                    properties: {
                        token: { type: "string" },
                        symbol: { type: "string" },
                        decimals: { type: "integer" },
                        marketCapUsdc: { type: "string" },
                        marketCapUsdcFmt: { type: "string" },
                        priceUsdc: { type: "string" },
                        migrated: { type: "boolean" },
                        curveProgressBps: { type: "integer" },
                        tradeVia: { type: "string", enum: ["launchpad", "swap"] },
                    },
                },
                Portfolio: {
                    type: "object",
                    properties: {
                        wallet: { type: "string" },
                        totalValueUsdc: { type: "string" },
                        totalValueUsdcFmt: { type: "string" },
                        balances: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    symbol: { type: "string" },
                                    address: { type: "string" },
                                    decimals: { type: "integer" },
                                    balanceRaw: { type: "string" },
                                    balanceFmt: { type: "string" },
                                    valueUsdc: { type: "string", nullable: true },
                                    valueUsdcFmt: { type: "string", nullable: true },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
}
