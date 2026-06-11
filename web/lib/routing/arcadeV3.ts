import { Address } from "viem";
import { ADDRESSES, V3_FEE } from "@/lib/constants";
import { V3_QUOTER_ABI, V3_ROUTER_ABI } from "@/lib/abis/v3";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * Arcade V3 provider — wraps the existing custom-flat-args quoter +
 * router pair shipped with CLANKER_V3 launches. Single fee tier
 * (V3_FEE = 10_000 = 1%, all Arcade V3 pools at that tier) so no
 * Factory.getPool fan-out: just call the quoter once.
 *
 * Quoter has two functions: `quoteExactInputSingle` for direct
 * (USDC <-> clanker) pairs, and `quoteExactInputThroughUsdc` for
 * clanker-to-clanker via USDC mid. We pick based on whether USDC
 * is on either side of the requested pair.
 */
export const arcadeV3Provider: RouteProvider = {
  meta: PROVIDER_META["arcade-v3"],

  async quote(req, publicClient) {
    if (ADDRESSES.v3Quoter === ZERO || ADDRESSES.v3Router === ZERO) return null;
    if (req.amountIn === 0n) return null;

    const isUsdcIn = req.tokenIn.toLowerCase() === ADDRESSES.usdc.toLowerCase();
    const isUsdcOut = req.tokenOut.toLowerCase() === ADDRESSES.usdc.toLowerCase();
    const direct = isUsdcIn || isUsdcOut;
    const functionName = direct ? "quoteExactInputSingle" : "quoteExactInputThroughUsdc";

    // Audit 2026-06-11 ROUTING-1: anti-sniper tax read INSIDE the provider
    // so the quoted amountOut matches what the router actually executes.
    // The contract router skims on BOTH directions:
    //   - USDC->clanker buy: skim by currentSnipeBps(tokenOut), router pays
    //     skim from input, leg uses (amountIn - skim).
    //   - clanker->USDC sell (direct): skim by currentSnipeBps(tokenIn),
    //     router pays skim from input, leg uses (amountIn - skim).
    //   - clanker->USDC->clanker (multi-hop): contract today only skims the
    //     leg-2 buy side; CONTRACT-1 fix (gen 9) will also skim leg-1 sell.
    //     We over-skim defensively here so post-gen-9 the quote matches and
    //     pre-gen-9 the actual output is HIGHER than what we quote, which is
    //     safe (the swap's amountOutMinimum passes more easily).
    //
    // Prior version only deducted the buy-side skim; sells reverted on
    // slippage every time during the snipe window, and multi-hop quotes
    // were systematically too optimistic by ~the snipe rate.
    async function readSnipeBps(token: Address): Promise<bigint> {
      if (ADDRESSES.launchpad === ZERO) return 0n;
      try {
        const bps = (await publicClient.readContract({
          address: ADDRESSES.launchpad,
          abi: LAUNCHPAD_ABI,
          functionName: "currentSnipeBps",
          args: [token],
        })) as bigint;
        return bps;
      } catch {
        return 0n;
      }
    }

    let snipeBps = 0n;
    if (direct) {
      // Direct: one side is USDC; the other is the clanker we read the
      // skim from. isUsdcIn => skim on tokenOut (buy); isUsdcOut => skim
      // on tokenIn (sell).
      const taxedSide = isUsdcIn ? req.tokenOut : req.tokenIn;
      snipeBps = await readSnipeBps(taxedSide);
    } else {
      // Multi-hop clanker->clanker: skim both legs. Sum the two bps so
      // they apply against the input amount as a single factor.
      const [bpsIn, bpsOut] = await Promise.all([
        readSnipeBps(req.tokenIn),
        readSnipeBps(req.tokenOut),
      ]);
      snipeBps = bpsIn + bpsOut;
    }
    const netAmountIn = req.amountIn - (req.amountIn * snipeBps) / 10_000n;

    let amountOut: bigint;
    try {
      const result = await publicClient.readContract({
        address: ADDRESSES.v3Quoter,
        abi: V3_QUOTER_ABI,
        functionName,
        args: [req.tokenIn, req.tokenOut, V3_FEE, netAmountIn],
      });
      amountOut = result as bigint;
    } catch {
      return null;
    }
    if (amountOut === 0n) return null;

    const amountOutMinimum =
      (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;

    // Audit 2026-06-11 ROUTING-2: compute a real `usdcMidMin` floor for
    // multi-hop so the on-chain MID_SLIPPAGE check (router line 140) is
    // re-enabled. Quoting leg 1 alone gives us the expected USDC mid; we
    // floor it at 97% to leave room for honest price movement while still
    // blocking a sandwich that drops the mid by >3%. Prior `0n` left the
    // router's mid-leg sandwich defence inert.
    let usdcMidMin = 0n;
    if (!direct) {
      try {
        const usdcMid = (await publicClient.readContract({
          address: ADDRESSES.v3Quoter,
          abi: V3_QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args: [req.tokenIn, ADDRESSES.usdc, V3_FEE, netAmountIn],
        })) as bigint;
        // Audit 2026-06-11 v2 ADVR-3: scale the mid-leg floor to the user's
        // slippage tolerance. Hardcoded 97% (3% mid tolerance) confused
        // users who'd set 5%+ slippage on volatile pairs — the final-out
        // gate would allow the move but the mid-leg would revert. With
        // `(10_000 - slippageBps) / 10_000` the mid floor equals the final
        // tolerance, so any sandwich that fits inside the user's slippage
        // budget passes both gates symmetrically.
        const tolerance = 10_000n - BigInt(req.slippageBps);
        usdcMidMin = (usdcMid * tolerance) / 10_000n;
      } catch {
        usdcMidMin = 0n;
      }
    }

    // Arcade V3 router has both exactInputSingle (direct) and
    // exactInputThroughUsdc (multi-hop via USDC). The router itself
    // handles the routing; we just pick the right function name.
    const execFn = direct ? "exactInputSingle" : "exactInputThroughUsdc";
    const execArgs = direct
      ? [
          req.tokenIn,
          req.tokenOut,
          V3_FEE,
          req.recipient,
          req.amountIn,
          amountOutMinimum,
          req.deadline,
        ]
      : [
          req.tokenIn,
          req.tokenOut,
          V3_FEE,
          req.recipient,
          req.amountIn,
          amountOutMinimum,
          usdcMidMin,
          req.deadline,
        ];

    const executor: RouteQuote["executor"] = {
      router: ADDRESSES.v3Router,
      abi: V3_ROUTER_ABI,
      functionName: execFn,
      args: execArgs,
    };

    return {
      provider: "arcade-v3",
      amountOut,
      fee: V3_FEE,
      pathLabel: direct ? "1.00% pool" : "via USDC",
      approval: {
        token: req.tokenIn,
        spender: ADDRESSES.v3Router,
        amount: req.amountIn,
      },
      executor,
    };
  },
};

// Helper for the SwapCard to short-circuit when both sides are clearly V3:
// callers pre-check this so we skip a doomed quote on pure-V2 pairs.
export function pairLooksV3(tokenIn: Address, tokenOut: Address, isV3Token: (a: Address) => boolean): boolean {
  return isV3Token(tokenIn) || isV3Token(tokenOut);
}
