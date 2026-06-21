import { Address } from "viem";
import type { QuoteRequest, RouteProvider, RouteQuote } from "./types";
import { arcadeV3Provider } from "./arcadeV3";
import { arcadeV2Provider } from "./arcadeV2";
import { synthraV3Provider } from "./synthraV3";
import { unitflowV3Provider } from "./unitflowV3";
import { xylonetV1Provider } from "./xylonetV1";

/**
 * Every routing provider, same set the single-swap aggregator uses.
 *
 * MultiSwap quotes each input leg across all of these and picks the best
 * amountOut per leg — so a USDC->USDT leg can price off Synthra (where the
 * stable liquidity is) instead of a thin Arcade pair, and a launch token
 * still routes through Arcade. At execution time the MultiSwapCard splits
 * the chosen routes by settlement model: classic-approve routes (Arcade
 * V2/V3, XyloNet) fold into ONE Multicall3From signature, while Permit2
 * routes (Synthra / UnitFlow via UniversalRouter) each settle with their
 * own PermitSingle signature + execute() call.
 */
const PROVIDERS: RouteProvider[] = [
  arcadeV3Provider,
  arcadeV2Provider,
  synthraV3Provider,
  unitflowV3Provider,
  xylonetV1Provider,
];

/**
 * Quote a single input→output leg across every provider and return the
 * route with the highest amountOut (or null if none has liquidity).
 * Never throws — a provider that reverts is dropped.
 */
export async function quoteBestLeg(
  req: QuoteRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any,
): Promise<RouteQuote | null> {
  const quotes = await Promise.all(
    PROVIDERS.map((p) => p.quote(req, publicClient).catch(() => null)),
  );
  let best: RouteQuote | null = null;
  for (const q of quotes) {
    if (!q || q.amountOut <= 0n) continue;
    if (!best || q.amountOut > best.amountOut) best = q;
  }
  return best;
}

/** Convenience shape for callers that quote many legs at once. */
export interface LegQuoteInput {
  tokenIn: Address;
  decimalsIn: number;
  amountIn: bigint;
}

/**
 * Quote N legs (all to the same tokenOut) in parallel. Returns one
 * RouteQuote-or-null per input, index-aligned with `legs`.
 */
export async function quoteBestLegs(
  legs: LegQuoteInput[],
  shared: Omit<QuoteRequest, "tokenIn" | "decimalsIn" | "amountIn">,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any,
): Promise<(RouteQuote | null)[]> {
  return Promise.all(
    legs.map((leg) =>
      quoteBestLeg(
        {
          ...shared,
          tokenIn: leg.tokenIn,
          decimalsIn: leg.decimalsIn,
          amountIn: leg.amountIn,
        },
        publicClient,
      ),
    ),
  );
}
