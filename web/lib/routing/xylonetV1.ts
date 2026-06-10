import { Address } from "viem";
import { ADDRESSES } from "@/lib/constants";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * XyloNet provider — StableSwap pool (Curve invariant) wrapped behind a
 * Uniswap V2-style router ABI at `ADDRESSES.xyloRouter`. The router
 * exposes the standard V2 surface:
 *   - swapExactTokensForTokens(amountIn, amountOutMin, path[], to, deadline)
 *   - getAmountsOut(amountIn, path[]) — returns the array of amounts per leg
 * Curve math runs inside the pool's getAmountOut callback, but as far as
 * the integration is concerned this looks exactly like our Arcade V2
 * provider. We reuse the V2 ROUTER_ABI verbatim.
 *
 * Native USDC: XyloRouter accepts the native Arc USDC at 0x3600...
 * directly (the pool holds an immutable USDC field), so unlike UnitFlow
 * we do NOT need a wrap step. That's why Tower's USDC → EURC swap via
 * XyloNet lands in one tx with no wrap visible.
 *
 * Supported pairs (as of 2026-06-10): USDC ↔ EURC and USDC ↔ USYC. No
 * USDC ↔ USDT, no USDC ↔ cirBTC. getAmountsOut reverts when the pair
 * has no pool — caught and returned as null below so unsupported pairs
 * drop out of the comparison cleanly.
 */
export const xylonetV1Provider: RouteProvider = {
  meta: PROVIDER_META["xylonet-v1"],

  async quote(req, publicClient) {
    if (ADDRESSES.xyloRouter === ZERO) return null;
    if (req.amountIn === 0n) return null;

    const path: Address[] = [req.tokenIn, req.tokenOut];

    let amountOut: bigint = 0n;
    try {
      const amounts = (await publicClient.readContract({
        address: ADDRESSES.xyloRouter,
        abi: ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [req.amountIn, path],
      })) as bigint[];
      amountOut = amounts[amounts.length - 1] ?? 0n;
    } catch {
      // No pool for this pair on XyloNet — the router reverts. Drop out.
      return null;
    }
    if (amountOut === 0n) return null;

    const amountOutMin =
      (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;

    const executor: RouteQuote["executor"] = {
      router: ADDRESSES.xyloRouter,
      abi: ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [req.amountIn, amountOutMin, path, req.recipient, req.deadline],
    };

    return {
      provider: "xylonet-v1",
      amountOut,
      pathLabel: "stable pool",
      approval: {
        token: req.tokenIn,
        spender: ADDRESSES.xyloRouter,
        amount: req.amountIn,
      },
      executor,
    };
  },
};
