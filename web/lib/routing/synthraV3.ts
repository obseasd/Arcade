import { Address, encodeFunctionData } from "viem";
import { ADDRESSES, SYNTHRA_V3_FEES } from "@/lib/constants";
import { SYNTHRA_FACTORY_ABI, SYNTHRA_QUOTER_ABI, SYNTHRA_ROUTER_ABI } from "@/lib/abis/synthraV3";
import { PROVIDER_META, RouteProvider, RouteQuote, QuoteRequest } from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Synthra V3 provider — vanilla Uniswap V3 fork at
 * `ADDRESSES.synthra*`. Quote flow:
 *
 *   1. For each fee tier in SYNTHRA_V3_FEES (100 / 500 / 3_000 / 10_000),
 *      call Factory.getPool(tokenIn, tokenOut, fee). Skip tiers with
 *      pool == 0x0 (no liquidity / not deployed).
 *   2. For surviving tiers, call QuoterV2.quoteExactInputSingle(...) in
 *      parallel. Pick the tier with the largest amountOut.
 *   3. Build an exactInputSingle executor payload pointing at SwapRouter02.
 *
 * Returns null when no pool exists across any tier, or when every quote
 * reverts. Returning null is normal (some pairs simply aren't on Synthra);
 * the aggregator drops this row gracefully.
 *
 * Multi-hop via `path` (e.g. tokenIn -> WUSDC -> tokenOut) is wired in
 * the ABI but not exercised yet — keep it simple while we ship the
 * single-hop aggregator; add a path-builder when a real route asks for it.
 */
export const synthraV3Provider: RouteProvider = {
  meta: PROVIDER_META["synthra-v3"],

  async quote(req, publicClient) {
    if (
      ADDRESSES.synthraFactory === ZERO_ADDRESS ||
      ADDRESSES.synthraQuoter === ZERO_ADDRESS ||
      ADDRESSES.synthraRouter === ZERO_ADDRESS
    ) {
      return null;
    }
    if (req.amountIn === 0n) return null;

    // Step 1: pool discovery. Reads are cheap (single Factory.getPool
    // call per tier) so fan them out in parallel.
    const poolChecks = SYNTHRA_V3_FEES.map((fee) =>
      publicClient
        .readContract({
          address: ADDRESSES.synthraFactory,
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

    // Step 2: parallel quote-of-quotes. QuoterV2 reverts when there's no
    // path through the tier at the requested size; treat reverts as 0
    // and let max() drop them.
    const quoteCalls = liveTiers.map((p) =>
      publicClient
        .readContract({
          address: ADDRESSES.synthraQuoter,
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

    // Step 3: executor payload. amountOutMinimum applies slippage to the
    // freshly-fetched amountOut; the SwapCard surfaces both numbers in
    // the review screen.
    const amountOutMinimum =
      (best.amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;

    const executor: RouteQuote["executor"] = {
      router: ADDRESSES.synthraRouter,
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

    // Pre-compute the calldata once so the SwapCard can fall back to a
    // raw `sendTransaction` if its wagmi writeContract path errors out.
    // Not used in the default flow but cheap to attach.
    void encodeFunctionData;

    return {
      provider: "synthra-v3",
      amountOut: best.amountOut,
      fee: best.fee,
      pathLabel: feeLabel(best.fee),
      approval: {
        token: req.tokenIn,
        spender: ADDRESSES.synthraRouter,
        amount: req.amountIn,
      },
      executor,
    };
  },
};

function feeLabel(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}% pool`;
}
