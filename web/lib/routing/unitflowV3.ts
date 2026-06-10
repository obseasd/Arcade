import { Address } from "viem";
import { ADDRESSES, SYNTHRA_V3_FEES } from "@/lib/constants";
import { SYNTHRA_FACTORY_ABI, SYNTHRA_QUOTER_ABI, SYNTHRA_ROUTER_ABI } from "@/lib/abis/synthraV3";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * UnitFlow V3 provider — Uniswap V3 fork at `ADDRESSES.unitflow*` with
 * the standard interfaces renamed (UnitFlowV3*). Same call shape as
 * Synthra so we reuse the Uniswap-V3 standard ABIs.
 *
 * WUSDC routing: UnitFlow pools route through Wrapped USDC (18 dec) not
 * native Arc USDC (6 dec). For a USDC <-> X swap the correct flow is
 *   wrap USDC -> WUSDC -> swap on WUSDC/X pool -> (optionally unwrap)
 * which their frontend encodes as a UniversalRouter command stream
 * (WRAP_ETH + V3_SWAP_EXACT_IN + SWEEP/UNWRAP_WETH). Implementing that
 * encoder is its own piece of work, so for now we skip UnitFlow on any
 * pair that has native USDC on either side and only quote/execute pairs
 * where both sides are already non-USDC tokens (the WUSDC/EURC,
 * EURC/cirBTC, etc. matrix). Add the UniversalRouter executor in a
 * follow-up to unlock the USDC <-> X matrix too.
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

    // Skip native-USDC pairs until the UniversalRouter wrap+swap path
    // is wired. Quoting the WUSDC pool is straightforward but executing
    // requires a multi-command UniversalRouter call that lives outside
    // this MVP scope.
    const isUsdc = (a: Address) =>
      a.toLowerCase() === ADDRESSES.usdc.toLowerCase();
    if (isUsdc(req.tokenIn) || isUsdc(req.tokenOut)) {
      return null;
    }

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
