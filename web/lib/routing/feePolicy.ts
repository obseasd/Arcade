import { Address, encodeFunctionData, Hex } from "viem";
import { ADDRESSES } from "@/lib/constants";
import { ProviderId, RouteQuote, QuoteRequest } from "./types";

/**
 * Router-level swap fee policy for EXTERNAL launchpad/memecoin tokens.
 *
 * The Arcade UI is a multi-venue aggregator. Policy (product-locked):
 *  - Fee ONLY on external-venue swaps whose non-base side is someone else's
 *    token (radardex/sharc/Arclight/canonical Uniswap on Arc, etc.).
 *  - 0 fee on base-asset<->base-asset swaps (USDC/ETH/EURC/cirBTC/WUSDC).
 *  - 0 router fee on Arcade's own venues (arcade-v2/v3/v4) -- our own launchpad
 *    tokens are already fee'd at the pool/hook level; no double-dip.
 *
 * Mechanism: when a swap is taxable AND `ADDRESSES.swapFeeRouter` is live, the
 * SwapCard reroutes the trade through the ArcadeSwapFeeRouter (0.5% input-side
 * fee to the treasury) instead of straight to the venue router. The reroute
 * targets the venue's CLASSIC SwapRouter02 (allowance-based exactInputSingle) --
 * NOT its UniversalRouter (Permit2) -- because the fee router pulls via a plain
 * ERC20 allowance. Non-taxable swaps route directly, unchanged.
 */

/** The router-level fee we take, in bps. Must match the deployed FeeRouter's
 *  feeBps; passed as the trader's maxFeeBps so a concurrent owner setFeeBps
 *  above this reverts rather than silently overcharging. */
export const SWAP_FEE_BPS = 50; // 0.50%

/** Base assets: never taxed (utility swaps, ultra-competitive). Lowercased. */
function baseAssetSet(): Set<string> {
    return new Set(
        [ADDRESSES.usdc, ADDRESSES.weth, ADDRESSES.eurc, ADDRESSES.cirBtc, ADDRESSES.wusdc]
            .filter((a): a is Address => !!a && a !== "0x0000000000000000000000000000000000000000")
            .map((a) => a.toLowerCase()),
    );
}

/**
 * External LAUNCHPAD venues we reroute through the FeeRouter, mapped to the
 * CLASSIC Uniswap-V3 SwapRouter02 the FeeRouter forwards to (allowance-based).
 *
 * INVARIANT: a venue appears here ONLY when its SwapRouter02 is ALSO allow-listed
 * in the deployed FeeRouter -- the two MUST be wired together, or a wrapped swap
 * reverts RouterNotAllowed. So this map is empty until a launchpad venue is
 * explicitly activated, which keeps the whole feature a strict no-op meanwhile.
 *
 * NOT here by design: Arcade's own venues (never fee'd), and third-party generic
 * DEXs like synthra/unitflow (they're DEXs, not launchpads -- out of the "fee on
 * external launchpad tokens" policy). Wire real launchpad venues as we get their
 * addresses: Arclight (testnet), radardex/sharc + canonical Uniswap SwapRouter02
 * 0x53bf6b06... (Arc mainnet). Each addition also needs setRouterAllowed on the
 * FeeRouter from the Safe.
 */
function externalV3Router(provider: ProviderId): Address | null {
    const map: Partial<Record<ProviderId, Address | undefined>> = {
        // e.g. "arclight-v3": ADDRESSES.arclightRouter,  (add on activation)
    };
    const r = map[provider];
    return r && r !== "0x0000000000000000000000000000000000000000" ? r : null;
}

/**
 * Is this winning route a taxable external-token swap?
 * True iff: (a) the FeeRouter is live, (b) the venue is an external V3 venue we
 * can reroute, (c) at least one side is a non-base token (not base<->base).
 */
export function isTaxableExternalSwap(quote: RouteQuote, tokenIn: Address, tokenOut: Address): boolean {
    if (!ADDRESSES.swapFeeRouter || ADDRESSES.swapFeeRouter === "0x0000000000000000000000000000000000000000") {
        return false;
    }
    if (externalV3Router(quote.provider) === null) return false; // arcade venues / unsupported
    const base = baseAssetSet();
    const inBase = base.has(tokenIn.toLowerCase());
    const outBase = base.has(tokenOut.toLowerCase());
    return !(inBase && outBase); // both base -> utility swap, no fee
}

/** Uniswap V3 SwapRouter02 exactInputSingle (no deadline in params). */
const SWAP_ROUTER_02_ABI = [
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

/** ArcadeSwapFeeRouter.swap(tokenIn,tokenOut,amountIn,minOut,maxFeeBps,router,swapData). */
const FEE_ROUTER_ABI = [
    {
        type: "function",
        name: "swap",
        stateMutability: "nonpayable",
        inputs: [
            { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" },
            { name: "amountIn", type: "uint256" },
            { name: "minOut", type: "uint256" },
            { name: "maxFeeBps", type: "uint16" },
            { name: "router", type: "address" },
            { name: "swapData", type: "bytes" },
        ],
        outputs: [{ name: "amountOut", type: "uint256" }],
    },
] as const;

/**
 * Rewrite a winning EXTERNAL single-hop V3 RouteQuote to go through the
 * ArcadeSwapFeeRouter: approve the FeeRouter (classic allowance, no Permit2),
 * skim 0.5% on input, forward the net to the venue's classic SwapRouter02.
 *
 * Returns null when the route can't be fee-wrapped (no fee tier / no classic
 * router / multi-hop pivot) -- caller falls back to the original direct route
 * (unchanged, no fee). Only single-hop V3 (the radardex/sharc/Uniswap-direct
 * case: USDC<->token) is wrapped in v1.
 */
export function wrapWithFeeRouter(quote: RouteQuote, req: QuoteRequest): RouteQuote | null {
    const feeRouter = ADDRESSES.swapFeeRouter as Address;
    const venueRouter = externalV3Router(quote.provider);
    if (!venueRouter) return null;
    if (quote.fee === undefined) return null; // only single-hop V3 (has a fee tier)

    const amountIn = req.amountIn;
    const net = amountIn - (amountIn * BigInt(SWAP_FEE_BPS)) / 10_000n;
    // minOut on the NET input: the swap runs on `net`, so scale the quote's
    // full-input amountOut down proportionally, then apply slippage. The fee is
    // small (0.5%) so the linear scaling error is well inside slippage.
    const amountOutNet = (quote.amountOut * net) / amountIn;
    const minOut = (amountOutNet * BigInt(10_000 - req.slippageBps)) / 10_000n;

    // Venue calldata: exactInputSingle on `net`, output back to the FeeRouter.
    const venueSwapData: Hex = encodeFunctionData({
        abi: SWAP_ROUTER_02_ABI,
        functionName: "exactInputSingle",
        args: [
            {
                tokenIn: req.tokenIn,
                tokenOut: req.tokenOut,
                fee: quote.fee,
                recipient: feeRouter,
                amountIn: net,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0n,
            },
        ],
    });

    return {
        ...quote,
        // Show the net-of-fee output so the displayed number matches delivery.
        amountOut: amountOutNet,
        pathLabel: (quote.pathLabel ?? "") + " · 0.5% fee",
        approval: { token: req.tokenIn, spender: feeRouter, amount: amountIn },
        executor: {
            router: feeRouter,
            abi: FEE_ROUTER_ABI,
            functionName: "swap",
            args: [req.tokenIn, req.tokenOut, amountIn, minOut, SWAP_FEE_BPS, venueRouter, venueSwapData],
            value: 0n,
        },
        // FeeRouter pulls via classic allowance -> no Permit2 flow.
        permit2: undefined,
    };
}
