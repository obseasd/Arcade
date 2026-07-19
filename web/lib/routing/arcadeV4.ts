import { Address } from "viem";
import { RouteProvider, RouteQuote, QuoteRequest } from "./types";
import { ADDRESSES } from "@/lib/constants";
import { ARCADE_HOOK_ABI } from "@/lib/abis/arcadeHook";
import { V4_ROUTER_ABI } from "@/lib/abis/v4Router";
import { V4_QUOTER_ABI } from "@/lib/abis/v4Quoter";

// Every ArcadeHook launch pool is built with tickSpacing 200 and the hook as
// its hook (see ArcadeHook._buildPoolKey). The fee is the pool's stored fee
// (poolFeeOf: the CLANKER tier, or 0 for a PUMP pool where the hook captures).
const TICK_SPACING = 200;
const ZERO_POOLID = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Arcade V4 route provider. Quotes single-hop USDC <-> launch-token swaps on the
 * canonical Uniswap V4 pool a token was launched into (CLANKER from birth, PUMP
 * after graduation), and executes them through ArcadeV4SwapRouter. Mirrors the
 * PoolKey the hook builds; a curving PUMP token (pool not yet initialised) or a
 * non-hook token simply reverts the quoter -> this provider returns null and the
 * aggregator drops it, exactly like a missing V2/V3 pool.
 */
export const arcadeV4Provider: RouteProvider = {
  meta: {
    id: "arcade-v4",
    label: "Arcade V4",
    longLabel: "Arcade Uniswap V4 hook pools (CLANKER + graduated PUMP)",
    accent: "text-cyan-400",
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async quote(req: QuoteRequest, publicClient: any): Promise<RouteQuote | null> {
    try {
      const usdc = ADDRESSES.usdc;
      const inIsUsdc = req.tokenIn.toLowerCase() === usdc.toLowerCase();
      const outIsUsdc = req.tokenOut.toLowerCase() === usdc.toLowerCase();
      // V4 launch pools are USDC-paired, single hop. Exactly one side is USDC.
      if (inIsUsdc === outIsUsdc) return null;
      const launchToken = (inIsUsdc ? req.tokenOut : req.tokenIn) as Address;

      // Gate: only real hook tokens have a poolId. Skips a wasted quote on
      // every V2/V3 token the aggregator also fans this request out for.
      const poolId = (await publicClient.readContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "poolIdOf",
        args: [launchToken],
      })) as `0x${string}`;
      if (!poolId || poolId.toLowerCase() === ZERO_POOLID) return null;

      const fee = Number(
        (await publicClient.readContract({
          address: ADDRESSES.arcadeHook,
          abi: ARCADE_HOOK_ABI,
          functionName: "poolFeeOf",
          args: [launchToken],
        })) as bigint | number,
      );

      // PoolKey exactly as the hook builds it (currencies sorted by address).
      const [c0, c1] =
        usdc.toLowerCase() < launchToken.toLowerCase() ? [usdc, launchToken] : [launchToken, usdc];
      const poolKey = {
        currency0: c0,
        currency1: c1,
        fee,
        tickSpacing: TICK_SPACING,
        hooks: ADDRESSES.arcadeHook,
      } as const;
      const zeroForOne = req.tokenIn.toLowerCase() === c0.toLowerCase();

      // Off-chain quote (the V4 quoter reverts to unwind state, so simulate).
      const sim = await publicClient.simulateContract({
        address: ADDRESSES.v4Quoter,
        abi: V4_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey, zeroForOne, exactAmount: req.amountIn, hookData: "0x" }],
      });
      const amountOut = (sim.result as readonly [bigint, bigint])[0];
      if (!amountOut || amountOut === 0n) return null;

      const minOut = (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;

      return {
        provider: "arcade-v4",
        amountOut,
        fee: fee > 0 ? fee : undefined,
        // The router pulls the input via transferFrom(payer) -> approve it.
        approval: { token: req.tokenIn, spender: ADDRESSES.v4Router, amount: req.amountIn },
        executor: {
          router: ADDRESSES.v4Router,
          abi: V4_ROUTER_ABI,
          functionName: "exactInputSingle",
          // (key, zeroForOne, amountIn, minAmountOut, recipient, sqrtPriceLimitX96=0)
          args: [poolKey, zeroForOne, req.amountIn, minOut, req.recipient, 0n],
        },
      };
    } catch {
      return null;
    }
  },
};
