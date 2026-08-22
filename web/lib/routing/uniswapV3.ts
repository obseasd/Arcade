import { Address } from "viem";
import { ADDRESSES } from "@/lib/constants";
import { SYNTHRA_FACTORY_ABI, SYNTHRA_QUOTER_ABI } from "@/lib/abis/synthraV3";
import { PROVIDER_META, QuoteRequest, RouteProvider, RouteQuote } from "./types";

/**
 * Canonical Uniswap V3 provider for Arc MAINNET (chainId 5042). This is where
 * external launchpad/memecoin tokens live (radardex trades via these pools;
 * sharc + Uniswap-native tokens too), so it is the venue that carries the 0.5%
 * router fee on external tokens.
 *
 * DORMANT on testnet: gated on chainId === 5042. The canonical Uniswap addresses
 * (constants.uniswapV3*) have no code on Arc testnet (5042002), so without the
 * gate every quote would be a wasted RPC round-trip that reverts. With the gate
 * the provider returns null instantly off-mainnet -> zero obstruction, and it
 * switches ON automatically the moment the app runs on mainnet. No env, no code
 * change needed at the cutover.
 *
 * Executes via the CLASSIC SwapRouter02 (exactInputSingle, allowance-based, no
 * Permit2) -- the same router the ArcadeSwapFeeRouter forwards to when a swap is
 * fee-wrapped (feePolicy kind "v3"). So the wrapped and unwrapped paths share the
 * exact router + calldata shape.
 *
 * NOTE: Arc mainnet has NO WETH, so pools are USDC-paired; v1 quotes DIRECT
 * single-hop tokenIn<->tokenOut pools only.
 */

const ARC_MAINNET_CHAIN_ID = 5042;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Uniswap SwapRouter02 exactInputSingle (no deadline in params). */
export const UNISWAP_SWAP_ROUTER_02_ABI = [
    {
        type: "function",
        name: "exactInputSingle",
        stateMutability: "payable",
        inputs: [
            {
                name: "params",
                type: "tuple",
                components: [
                    { name: "tokenIn", type: "address" },
                    { name: "tokenOut", type: "address" },
                    { name: "fee", type: "uint24" },
                    { name: "recipient", type: "address" },
                    { name: "amountIn", type: "uint256" },
                    { name: "amountOutMinimum", type: "uint256" },
                    { name: "sqrtPriceLimitX96", type: "uint160" },
                ],
            },
        ],
        outputs: [{ name: "amountOut", type: "uint256" }],
    },
] as const;

async function uniswapV3Quote(
    req: QuoteRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
): Promise<RouteQuote | null> {
    // MAINNET-ONLY gate: instant null off Arc mainnet (dormant on testnet).
    if (publicClient?.chain?.id !== ARC_MAINNET_CHAIN_ID) return null;

    const factory = ADDRESSES.uniswapV3Factory as Address;
    const quoter = ADDRESSES.uniswapV3Quoter as Address;
    const router = ADDRESSES.uniswapV3SwapRouter as Address;
    if (!factory || factory === ZERO || !quoter || quoter === ZERO || !router || router === ZERO) return null;
    if (req.amountIn === 0n) return null;
    if (req.tokenIn.toLowerCase() === req.tokenOut.toLowerCase()) return null;

    // Fan-out pool discovery across fee tiers.
    const pools = await Promise.all(
        FEE_TIERS.map((fee) =>
            publicClient
                .readContract({
                    address: factory,
                    abi: SYNTHRA_FACTORY_ABI,
                    functionName: "getPool",
                    args: [req.tokenIn, req.tokenOut, fee],
                })
                .then((pool: Address) => ({ fee, ok: pool !== ZERO }))
                .catch(() => ({ fee, ok: false })),
        ),
    );
    const live = pools.filter((p) => p.ok);
    if (live.length === 0) return null;

    // Quote each live tier, pick the best.
    const quotes = await Promise.all(
        live.map((p) =>
            publicClient
                .readContract({
                    address: quoter,
                    abi: SYNTHRA_QUOTER_ABI,
                    functionName: "quoteExactInputSingle",
                    args: [
                        {
                            tokenIn: req.tokenIn,
                            tokenOut: req.tokenOut,
                            amountIn: req.amountIn,
                            fee: p.fee,
                            sqrtPriceLimitX96: 0n,
                        },
                    ],
                })
                .then((result: readonly unknown[]) => ({ fee: p.fee, amountOut: result[0] as bigint }))
                .catch(() => ({ fee: p.fee, amountOut: 0n })),
        ),
    );
    let best = quotes[0];
    for (const q of quotes) if (q.amountOut > best.amountOut) best = q;
    if (best.amountOut === 0n) return null;

    const amountOutMinimum = (best.amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
    return {
        provider: "uniswap-v3",
        amountOut: best.amountOut,
        fee: best.fee,
        pathLabel: `${(best.fee / 10_000).toFixed(2)}% pool`,
        approval: { token: req.tokenIn, spender: router, amount: req.amountIn },
        executor: {
            router,
            abi: UNISWAP_SWAP_ROUTER_02_ABI,
            functionName: "exactInputSingle",
            args: [
                {
                    tokenIn: req.tokenIn,
                    tokenOut: req.tokenOut,
                    fee: best.fee,
                    recipient: req.recipient,
                    amountIn: req.amountIn,
                    amountOutMinimum,
                    sqrtPriceLimitX96: 0n,
                },
            ],
            value: 0n,
        },
    };
}

export const uniswapV3Provider: RouteProvider = {
    meta: PROVIDER_META["uniswap-v3"],
    async quote(req, publicClient) {
        try {
            return await uniswapV3Quote(req, publicClient);
        } catch {
            return null;
        }
    },
};

export { uniswapV3Quote };
