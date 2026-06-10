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

    // Audit A-4: anti-sniper tax read INSIDE the provider so the quoted
    // amountOut matches what the router actually executes. SwapCard's
    // legacy quoteV3 was deducting the skim before quoting; the
    // aggregator ignored it, producing too-optimistic quotes that
    // tripped slippage at exec time. Tax applies on USDC-in buys
    // (skim taken off the input); for sells the V3-3 fix already
    // skims on tokenIn → no quote-side correction needed.
    let snipeBps = 0n;
    if (isUsdcIn && ADDRESSES.launchpad !== ZERO) {
      try {
        const bps = (await publicClient.readContract({
          address: ADDRESSES.launchpad,
          abi: LAUNCHPAD_ABI,
          functionName: "currentSnipeBps",
          args: [req.tokenOut],
        })) as bigint;
        snipeBps = bps;
      } catch {
        snipeBps = 0n;
      }
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
          0n, // usdcMidMin — accept any USDC mid amount, slippage is on the final out
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
