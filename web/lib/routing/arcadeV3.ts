import { Address } from "viem";
import { ADDRESSES, V3_FEE } from "@/lib/constants";
import { V3_QUOTER_ABI, V3_ROUTER_ABI } from "@/lib/abis/v3";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * Standard Uniswap V3 fee tiers (1bp / 5bp / 30bp / 100bp). The arcade
 * V3 factory deploys pools on the same enum since the contracts are a
 * canonical V3 fork. Iteration order is least-fee-first because a
 * tighter tier almost always quotes a higher amountOut on the same
 * pool size, so the first valid quote tends to be the winner — keeps
 * the average response time low when one tier hits and the rest don't.
 */
const ARCADE_V3_FEE_TIERS = [100, 500, 3_000, 10_000] as const;

/**
 * Arcade V3 provider — fans out the quote across every standard V3
 * fee tier (0.01% / 0.05% / 0.3% / 1%) and returns the best result.
 *
 * Why fan out: the previous implementation hard-coded V3_FEE = 1%
 * because the launchpad's CLANKER_V3 mode only ever opens pools at
 * that tier. As soon as a user creates a regular V3 position at 0.3%
 * (USDC/SeedETH, USDC/cirBTC, etc.) the provider returned null and
 * the swap card fell back to V2, which reverted because no V2 pair
 * existed for the static testnet tokens. The user-facing symptom was
 * an infinite "Fetching price…" loop (wagmi retried the V2 quote
 * three times before giving up).
 *
 * The fan-out is 4 parallel readContract calls. Three of them revert
 * cheaply on Arc (uninitialised pool → empty return data → viem
 * decode error → caught), leaving the one tier that actually has
 * liquidity to drive the executor. Multi-hop (clanker → USDC →
 * clanker) keeps V3_FEE on BOTH legs because that path is always
 * launchpad-to-launchpad — a mixed-tier multi-hop is the proper
 * roadmap follow-up but no current pool needs it.
 */
export const arcadeV3Provider: RouteProvider = {
  meta: PROVIDER_META["arcade-v3"],

  async quote(req, publicClient) {
    if (ADDRESSES.v3Quoter === ZERO || ADDRESSES.v3Router === ZERO) return null;
    if (req.amountIn === 0n) return null;

    const isUsdcIn = req.tokenIn.toLowerCase() === ADDRESSES.usdc.toLowerCase();
    const isUsdcOut = req.tokenOut.toLowerCase() === ADDRESSES.usdc.toLowerCase();
    const direct = isUsdcIn || isUsdcOut;

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
      // on tokenIn (sell). Static V3 tokens (SeedETH, cirBTC...) return
      // 0 from currentSnipeBps because they were never indexed by the
      // launchpad, so the math collapses to a no-op for them.
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

    // Direct path: fan out across every standard V3 fee tier and pick
    // the highest quote. Most calls revert (pool not deployed at that
    // tier) so each one is wrapped in its own try/catch and stays out
    // of the result array on failure. Promise.all keeps wall-time at
    // ~max(latency) instead of sum.
    if (direct) {
      interface TierQuote {
        tier: number;
        amountOut: bigint;
      }
      const perTier = await Promise.all(
        ARCADE_V3_FEE_TIERS.map(async (tier): Promise<TierQuote | null> => {
          try {
            const out = (await publicClient.readContract({
              address: ADDRESSES.v3Quoter,
              abi: V3_QUOTER_ABI,
              functionName: "quoteExactInputSingle",
              args: [req.tokenIn, req.tokenOut, tier, netAmountIn],
            })) as bigint;
            if (out === 0n) return null;
            return { tier, amountOut: out };
          } catch {
            return null;
          }
        }),
      );
      const winners: TierQuote[] = perTier.filter(
        (q): q is TierQuote => q !== null,
      );
      if (winners.length === 0) return null;
      winners.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
      const best: TierQuote = winners[0];

      const amountOutMinimum =
        (best.amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
      const executor: RouteQuote["executor"] = {
        router: ADDRESSES.v3Router,
        abi: V3_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          req.tokenIn,
          req.tokenOut,
          best.tier,
          req.recipient,
          req.amountIn,
          amountOutMinimum,
          req.deadline,
        ],
      };

      const tierLabel = `${(best.tier / 10_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}% pool`;
      return {
        provider: "arcade-v3",
        amountOut: best.amountOut,
        fee: best.tier,
        pathLabel: tierLabel,
        approval: {
          token: req.tokenIn,
          spender: ADDRESSES.v3Router,
          amount: req.amountIn,
        },
        executor,
      };
    }

    // Multi-hop (clanker -> USDC -> clanker). Both legs stay on
    // V3_FEE because every CLANKER_V3 launch opens at that tier. A
    // mixed-tier multi-hop is the proper Fix C v2 add-on once any
    // non-clanker token sits on the second leg, but no current pool
    // needs it.
    let amountOut: bigint;
    try {
      const result = await publicClient.readContract({
        address: ADDRESSES.v3Quoter,
        abi: V3_QUOTER_ABI,
        functionName: "quoteExactInputThroughUsdc",
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
    // floor it at user's slippage to leave room for honest price
    // movement while still blocking a sandwich that drops the mid past
    // the configured tolerance. Prior `0n` left the router's mid-leg
    // sandwich defence inert.
    let usdcMidMin = 0n;
    try {
      const usdcMid = (await publicClient.readContract({
        address: ADDRESSES.v3Quoter,
        abi: V3_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [req.tokenIn, ADDRESSES.usdc, V3_FEE, netAmountIn],
      })) as bigint;
      // Audit 2026-06-11 v2 ADVR-3: scale the mid-leg floor to the user's
      // slippage tolerance so a sandwich that fits inside the user's
      // slippage budget passes both gates symmetrically.
      const tolerance = 10_000n - BigInt(req.slippageBps);
      usdcMidMin = (usdcMid * tolerance) / 10_000n;
    } catch {
      usdcMidMin = 0n;
    }

    const executor: RouteQuote["executor"] = {
      router: ADDRESSES.v3Router,
      abi: V3_ROUTER_ABI,
      functionName: "exactInputThroughUsdc",
      args: [
        req.tokenIn,
        req.tokenOut,
        V3_FEE,
        req.recipient,
        req.amountIn,
        amountOutMinimum,
        usdcMidMin,
        req.deadline,
      ],
    };

    return {
      provider: "arcade-v3",
      amountOut,
      fee: V3_FEE,
      pathLabel: "via USDC",
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
// Kept around for backwards compat with the SwapCard's V3-specific
// gating; the auto-discovery fan-out above ignores this check.
export function pairLooksV3(tokenIn: Address, tokenOut: Address, isV3Token: (a: Address) => boolean): boolean {
  return isV3Token(tokenIn) || isV3Token(tokenOut);
}
