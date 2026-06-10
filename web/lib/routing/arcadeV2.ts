import { Address } from "viem";
import { ADDRESSES } from "@/lib/constants";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * Arcade V2 provider — wraps the Uniswap V2 router pair shipped with
 * the launchpad migration. Direct path (tokenIn -> tokenOut) first; if
 * that quoteOut is zero, try the (tokenIn -> USDC -> tokenOut) multi-hop.
 *
 * Note: this provider DOES NOT cover migrated-token-fee routes (post-V2
 * graduation the launchpad takes a royalty cut on each leg whose pair
 * is migrated). Those go through the launchpad router and are quoted
 * separately by SwapCard's existing migrated-route path. Wire them in
 * a follow-up if we want the aggregator to score them too.
 */
export const arcadeV2Provider: RouteProvider = {
  meta: PROVIDER_META["arcade-v2"],

  async quote(req, publicClient) {
    if (ADDRESSES.router === ZERO) return null;
    if (req.amountIn === 0n) return null;

    // Direct path attempt.
    const directPath = [req.tokenIn, req.tokenOut];
    let amountOut: bigint = 0n;
    let path: Address[] = directPath;
    try {
      const amounts = (await publicClient.readContract({
        address: ADDRESSES.router,
        abi: ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [req.amountIn, directPath],
      })) as bigint[];
      amountOut = amounts[amounts.length - 1] ?? 0n;
    } catch {
      amountOut = 0n;
    }

    // Multi-hop through USDC if direct returned nothing AND neither side
    // is USDC already (a USDC-side direct route can fail for liquidity
    // reasons; adding USDC twice in the path is invalid).
    if (
      amountOut === 0n &&
      ADDRESSES.usdc !== ZERO &&
      req.tokenIn.toLowerCase() !== ADDRESSES.usdc.toLowerCase() &&
      req.tokenOut.toLowerCase() !== ADDRESSES.usdc.toLowerCase()
    ) {
      const hopPath: Address[] = [req.tokenIn, ADDRESSES.usdc, req.tokenOut];
      try {
        const amounts = (await publicClient.readContract({
          address: ADDRESSES.router,
          abi: ROUTER_ABI,
          functionName: "getAmountsOut",
          args: [req.amountIn, hopPath],
        })) as bigint[];
        const hopOut = amounts[amounts.length - 1] ?? 0n;
        if (hopOut > 0n) {
          amountOut = hopOut;
          path = hopPath;
        }
      } catch {
        // ignore — leave amountOut at 0 and return null below
      }
    }

    if (amountOut === 0n) return null;

    const amountOutMin =
      (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;

    const executor: RouteQuote["executor"] = {
      router: ADDRESSES.router,
      abi: ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [req.amountIn, amountOutMin, path, req.recipient, req.deadline],
    };

    return {
      provider: "arcade-v2",
      amountOut,
      pathLabel: path.length === 2 ? "direct" : "via USDC",
      approval: {
        token: req.tokenIn,
        spender: ADDRESSES.router,
        amount: req.amountIn,
      },
      executor,
    };
  },
};
