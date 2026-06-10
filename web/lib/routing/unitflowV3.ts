import { Address } from "viem";
import { ADDRESSES, SYNTHRA_V3_FEES } from "@/lib/constants";
import { SYNTHRA_FACTORY_ABI, SYNTHRA_QUOTER_ABI, SYNTHRA_ROUTER_ABI } from "@/lib/abis/synthraV3";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * UnitFlow V3 provider — Uniswap V3 fork at `ADDRESSES.unitflow*` with
 * the standard interfaces renamed (UnitFlowV3*). Same call shape as
 * Synthra so we reuse the Uniswap-V3 standard ABIs (Factory.getPool +
 * QuoterV2.quoteExactInputSingle + SwapRouter02.exactInputSingle).
 *
 * Pool discovery + tier-by-tier quoting + executor build mirror the
 * Synthra provider. Same 4 fee tiers (100 / 500 / 3_000 / 10_000); the
 * provider picks the tier with the largest amountOut and returns null
 * when no pool exists or every quote reverts.
 *
 * If UnitFlow rolls out a UniversalRouter in the future, swap the
 * executor.router to that and switch the executor.abi+functionName to
 * UniversalRouter.execute(...). The Provider interface lets the
 * SwapCard call this transparently.
 */
export const unitflowV3Provider: RouteProvider = {
  meta: PROVIDER_META["unitflow-v3"],

  async quote(req, publicClient) {
    if (
      ADDRESSES.unitflowFactory === ZERO_ADDRESS ||
      ADDRESSES.unitflowQuoter === ZERO_ADDRESS ||
      ADDRESSES.unitflowRouter === ZERO_ADDRESS
    ) {
      return null;
    }
    if (req.amountIn === 0n) return null;

    const poolChecks = SYNTHRA_V3_FEES.map((fee) =>
      publicClient
        .readContract({
          address: ADDRESSES.unitflowFactory,
          abi: SYNTHRA_FACTORY_ABI,
          functionName: "getPool",
          args: [req.tokenIn, req.tokenOut, fee],
        })
        .then((pool: Address) => ({ fee, pool, ok: pool !== ZERO_ADDRESS }))
        .catch(() => ({ fee, pool: ZERO_ADDRESS as Address, ok: false })),
    );
    const pools = await Promise.all(poolChecks);
    const liveTiers = pools.filter((p) => p.ok);
    if (liveTiers.length === 0) return null;

    const quoteCalls = liveTiers.map((p) =>
      publicClient
        .readContract({
          address: ADDRESSES.unitflowQuoter,
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
        .then((result: readonly unknown[]) => ({
          fee: p.fee,
          amountOut: result[0] as bigint,
        }))
        .catch(() => ({ fee: p.fee, amountOut: 0n })),
    );
    const quotes = await Promise.all(quoteCalls);
    let best = quotes[0];
    for (const q of quotes) if (q.amountOut > best.amountOut) best = q;
    if (best.amountOut === 0n) return null;

    const amountOutMinimum =
      (best.amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;

    const executor: RouteQuote["executor"] = {
      router: ADDRESSES.unitflowRouter,
      abi: SYNTHRA_ROUTER_ABI,
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
    };

    return {
      provider: "unitflow-v3",
      amountOut: best.amountOut,
      fee: best.fee,
      pathLabel: `${(best.fee / 10_000).toFixed(2)}% pool`,
      approval: {
        token: req.tokenIn,
        spender: ADDRESSES.unitflowRouter,
        amount: req.amountIn,
      },
      executor,
    };
  },
};
