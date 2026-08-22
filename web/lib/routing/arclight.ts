import { Address } from "viem";
import { ADDRESSES } from "@/lib/constants";
import { PROVIDER_META, QuoteRequest, RouteProvider, RouteQuote } from "./types";

/**
 * Arclight launchpad DEX provider (external Arc-testnet launchpad). Arclight
 * graduates tokens onto a V2-style AMM with a CUSTOM interface (not canonical
 * UniswapV2):
 *   factory.getPair(tokenA, tokenB) -> pair
 *   pair.getAmountOut(tokenIn, amountIn) -> amountOut   (fee already applied)
 *   router.swapExactTokensForTokens(amountIn, amountOutMin, tokenIn, tokenOut,
 *                                   to, deadline)        (single-hop, no path[])
 *
 * Verified on-chain against a graduated pool (CBDIV). This provider only quotes
 * DIRECT tokenIn<->tokenOut pools; there is no multi-hop pivot. Its tokens are
 * external, so a taxable Arclight route is rerouted through the ArcadeSwapFeeRouter
 * (see feePolicy.ts) which forwards to this same router.
 */

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const FACTORY_ABI = [
    {
        type: "function",
        name: "getPair",
        stateMutability: "view",
        inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
        ],
        outputs: [{ name: "pair", type: "address" }],
    },
] as const;

const PAIR_ABI = [
    {
        type: "function",
        name: "getAmountOut",
        stateMutability: "view",
        inputs: [
            { name: "tokenIn", type: "address" },
            { name: "amountIn", type: "uint256" },
        ],
        outputs: [{ name: "amountOut", type: "uint256" }],
    },
] as const;

export const ARCLIGHT_ROUTER_ABI = [
    {
        type: "function",
        name: "swapExactTokensForTokens",
        stateMutability: "nonpayable",
        inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "amountOutMin", type: "uint256" },
            { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
        ],
        outputs: [{ name: "amountOut", type: "uint256" }],
    },
] as const;

async function arclightQuote(
    req: QuoteRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
): Promise<RouteQuote | null> {
    const factory = ADDRESSES.arclightDexFactory as Address;
    const router = ADDRESSES.arclightDexRouter as Address;
    if (!factory || factory === ZERO || !router || router === ZERO) return null;
    if (req.amountIn === 0n) return null;
    if (req.tokenIn.toLowerCase() === req.tokenOut.toLowerCase()) return null;

    let pair: Address;
    try {
        pair = (await publicClient.readContract({
            address: factory,
            abi: FACTORY_ABI,
            functionName: "getPair",
            args: [req.tokenIn, req.tokenOut],
        })) as Address;
    } catch {
        return null;
    }
    if (!pair || pair === ZERO) return null;

    let amountOut: bigint;
    try {
        amountOut = (await publicClient.readContract({
            address: pair,
            abi: PAIR_ABI,
            functionName: "getAmountOut",
            args: [req.tokenIn, req.amountIn],
        })) as bigint;
    } catch {
        return null;
    }
    if (amountOut === 0n) return null;

    const amountOutMinimum = (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
    return {
        provider: "arclight-v2",
        amountOut,
        pathLabel: "Arclight pool",
        approval: { token: req.tokenIn, spender: router, amount: req.amountIn },
        executor: {
            router,
            abi: ARCLIGHT_ROUTER_ABI,
            functionName: "swapExactTokensForTokens",
            args: [req.amountIn, amountOutMinimum, req.tokenIn, req.tokenOut, req.recipient, req.deadline],
            value: 0n,
        },
    };
}

export const arclightProvider: RouteProvider = {
    meta: PROVIDER_META["arclight-v2"],
    async quote(req, publicClient) {
        try {
            return await arclightQuote(req, publicClient);
        } catch {
            return null;
        }
    },
};

export { arclightQuote };
