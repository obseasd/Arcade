"use client";

import { useEffect, useMemo, useState } from "react";
import { Address } from "viem";
import { usePublicClient } from "wagmi";
import { RouteProvider, RouteQuote, QuoteRequest } from "./types";
import { synthraV3Provider } from "./synthraV3";
import { arcadeV3Provider } from "./arcadeV3";
import { arcadeV2Provider } from "./arcadeV2";
import { unitflowV3Provider } from "./unitflowV3";

/**
 * Aggregator hook: fans out a quote request to every registered provider
 * in parallel and returns the resulting quotes sorted by `amountOut` desc.
 * Providers that have no pool / revert / time-out return null and are
 * filtered out — a Synthra outage does not block Arcade quotes and vice
 * versa.
 *
 * Adding a new DEX:
 *   1. Implement RouteProvider in `lib/routing/<dex>.ts`.
 *   2. Add it to PROVIDERS below.
 *   3. Add the ProviderId + meta in `types.ts`.
 * The aggregator + the UI's top-N display pick it up automatically.
 *
 * Cache key is built from request shape — a re-render with the same input
 * returns the same quotes without re-querying. Debounce is the caller's
 * job (typically handled by lastEdited / debounced input upstream).
 *
 * The hook tracks an internal `requestId` so an old in-flight request
 * (slow Synthra RPC, fast Arcade) cannot overwrite a newer one. Without
 * this, a user typing 5 USDC then 50 USDC could see the 5-USDC quotes
 * land second and clobber the 50-USDC display.
 */

const PROVIDERS: RouteProvider[] = [
  arcadeV3Provider,
  arcadeV2Provider,
  synthraV3Provider,
  unitflowV3Provider,
  // XyloNet pending — ForgeLabs has not published their StableSwap
  // contracts on Arc yet (docs site marks GitHub as "Soon"). Wire it
  // here when addresses land.
];

export interface UseRouteQuotesArgs {
  tokenIn?: Address;
  tokenOut?: Address;
  decimalsIn?: number;
  decimalsOut?: number;
  amountIn: bigint;
  recipient?: Address;
  slippageBps: number;
  /** Seconds-from-now used to compute the on-chain deadline. */
  deadlineSeconds?: number;
  /** Set to false to keep the hook idle (between user edits, etc.). */
  enabled?: boolean;
}

export interface UseRouteQuotesResult {
  quotes: RouteQuote[];
  /** True while at least one provider has not returned for the latest req. */
  loading: boolean;
  /** The auto-picked best route (= quotes[0] when non-empty). */
  best: RouteQuote | null;
}

export function useRouteQuotes(args: UseRouteQuotesArgs): UseRouteQuotesResult {
  const publicClient = usePublicClient();
  const [quotes, setQuotes] = useState<RouteQuote[]>([]);
  const [loading, setLoading] = useState(false);

  // Stable serialization of the request. JSON.stringify with BigInt
  // coercion so the dep array compares by value, not identity.
  const reqKey = useMemo(() => {
    if (!args.enabled || !args.tokenIn || !args.tokenOut || !args.recipient) return "";
    if (args.amountIn === 0n) return "";
    if (args.decimalsIn === undefined || args.decimalsOut === undefined) return "";
    return [
      args.tokenIn.toLowerCase(),
      args.tokenOut.toLowerCase(),
      args.decimalsIn,
      args.decimalsOut,
      args.amountIn.toString(),
      args.recipient.toLowerCase(),
      args.slippageBps,
    ].join("|");
  }, [
    args.enabled,
    args.tokenIn,
    args.tokenOut,
    args.decimalsIn,
    args.decimalsOut,
    args.amountIn,
    args.recipient,
    args.slippageBps,
  ]);

  useEffect(() => {
    if (!reqKey || !publicClient) {
      setQuotes([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const req: QuoteRequest = {
      tokenIn: args.tokenIn!,
      tokenOut: args.tokenOut!,
      decimalsIn: args.decimalsIn!,
      decimalsOut: args.decimalsOut!,
      amountIn: args.amountIn,
      recipient: args.recipient!,
      slippageBps: args.slippageBps,
      deadline: BigInt(Math.floor(Date.now() / 1000) + (args.deadlineSeconds ?? 600)),
    };
    Promise.all(
      PROVIDERS.map((p) =>
        p.quote(req, publicClient).catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const good = results.filter((r): r is RouteQuote => r !== null);
      good.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
      setQuotes(good);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, publicClient]);

  return { quotes, loading, best: quotes[0] ?? null };
}
