"use client";

import { useEffect, useMemo, useState } from "react";
import { Address } from "viem";
import { usePublicClient } from "wagmi";
import { RouteProvider, RouteQuote, QuoteRequest } from "./types";
import { synthraV3Provider } from "./synthraV3";
import { arcadeV4Provider } from "./arcadeV4";
import { arcadeV3Provider } from "./arcadeV3";
import { arcadeV2Provider } from "./arcadeV2";
import { unitflowV3Provider } from "./unitflowV3";
import { xylonetV1Provider } from "./xylonetV1";
import { usycTellerV1Provider } from "./usycTellerV1";

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
  arcadeV4Provider,
  arcadeV3Provider,
  arcadeV2Provider,
  synthraV3Provider,
  unitflowV3Provider,
  xylonetV1Provider,
  usycTellerV1Provider,
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

  // Audit R-7: debounce `amountIn` by 250 ms. Without it, a user typing
  // "1234567" fires 7 cascades × 5 providers × ~5 RPC = 175 reads in
  // <1 s — meaningful on Arc's rate-limited public RPC and visible in
  // the routes panel as a strobe of "loading" -> "best route" updates.
  // Debouncing on the raw bigint keeps the keystrokes-per-character
  // amountInRaw responsive for display purposes upstream but coalesces
  // them for the aggregator's fan-out trigger. AbortController in the
  // effect below kills any in-flight requests on the next change.
  const [debouncedAmountIn, setDebouncedAmountIn] = useState(args.amountIn);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmountIn(args.amountIn), 250);
    return () => clearTimeout(t);
  }, [args.amountIn]);

  // Stable serialization of the request. JSON.stringify with BigInt
  // coercion so the dep array compares by value, not identity.
  const reqKey = useMemo(() => {
    if (!args.enabled || !args.tokenIn || !args.tokenOut || !args.recipient) return "";
    if (debouncedAmountIn === 0n) return "";
    if (args.decimalsIn === undefined || args.decimalsOut === undefined) return "";
    return [
      args.tokenIn.toLowerCase(),
      args.tokenOut.toLowerCase(),
      args.decimalsIn,
      args.decimalsOut,
      debouncedAmountIn.toString(),
      args.recipient.toLowerCase(),
      args.slippageBps,
    ].join("|");
  }, [
    args.enabled,
    args.tokenIn,
    args.tokenOut,
    args.decimalsIn,
    args.decimalsOut,
    debouncedAmountIn,
    args.recipient,
    args.slippageBps,
  ]);

  useEffect(() => {
    if (!reqKey || !publicClient) {
      setQuotes([]);
      setLoading(false);
      return;
    }
    // Audit R-9: same-token in/out is a no-op. The TokenSelectModal
    // already filters via excludeAddress, but a token swap that happens
    // exactly while the aggregator is mid-flight can briefly emit a
    // QuoteRequest with tokenIn == tokenOut. Skip providers entirely
    // and clear quotes — every provider would return null anyway,
    // saving a 5-way RPC fan-out.
    if (
      args.tokenIn &&
      args.tokenOut &&
      args.tokenIn.toLowerCase() === args.tokenOut.toLowerCase()
    ) {
      setQuotes([]);
      setLoading(false);
      return;
    }
    if (debouncedAmountIn === 0n) {
      setQuotes([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Audit R-6: pass an AbortSignal so a fast-typing user doesn't
    // accumulate dead-but-still-running provider RPC fan-outs. Each
    // provider receives the signal and forwards it to viem; the abort
    // controller is cancelled on cleanup so the previous request's
    // RPC traffic is killed at the network layer, not just discarded
    // at the result-handling layer.
    const ctrl = new AbortController();
    setLoading(true);
    const req: QuoteRequest = {
      tokenIn: args.tokenIn!,
      tokenOut: args.tokenOut!,
      decimalsIn: args.decimalsIn!,
      decimalsOut: args.decimalsOut!,
      // Use the debounced amount, not the live `args.amountIn` — the
      // reqKey already includes debouncedAmountIn so this is consistent.
      amountIn: debouncedAmountIn,
      recipient: args.recipient!,
      slippageBps: args.slippageBps,
      deadline: BigInt(Math.floor(Date.now() / 1000) + (args.deadlineSeconds ?? 600)),
      signal: ctrl.signal,
    };
    Promise.all(
      PROVIDERS.map((p) =>
        p.quote(req, publicClient).catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const good = results.filter((r): r is RouteQuote => r !== null);
      // Audit R-10: bucket amountOut by 1 bp before sorting so a
      // 1-wei rounding difference between two equally-good routes does
      // not flip the "Best" badge. Within a bucket, fall back to a
      // stable provider preference: native Arcade routes first (no
      // sig dance), then XyloNet (V2-ABI, no Permit2 setup), then
      // Synthra, then UnitFlow. The user sees the same total cost on
      // a tie but the cheapest-to-execute route wins.
      const providerRank: Record<string, number> = {
        // Native Arcade routes first (no Permit2 / sig dance). V4 alongside V3.
        "arcade-v4": 0,
        "arcade-v3": 0,
        "arcade-v2": 1,
        "xylonet-v1": 2,
        "synthra-v3": 3,
        "unitflow-v3": 4,
      };
      // Audit M4 fix: strict total order. The previous comparator
      // bucketed each pair to ~1 bp of the larger amount and used the
      // provider rank inside the bucket. That works for a single
      // pair (a, b) but violates transitivity across a triple
      // (a, b, c) where (a, b) and (b, c) both fall inside a bucket
      // but (a, c) does not — TimSort is stable so the result still
      // sorts but the "best" route the UI auto-picks can be wrong.
      // Bucketing was an attempt at a "essentially tied" UX, and the
      // strict order with an exact-tie tiebreak achieves the same
      // intent (provider-rank breaks the tie when amounts are equal)
      // without the math hole. The 1-bp UI affordance, if we want it
      // back, belongs as a render-side badge on the route panel — not
      // baked into the sort key.
      good.sort((a, b) => {
        if (a.amountOut === b.amountOut) {
          return (providerRank[a.provider] ?? 99) - (providerRank[b.provider] ?? 99);
        }
        return b.amountOut > a.amountOut ? 1 : -1;
      });
      setQuotes(good);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, publicClient]);

  return { quotes, loading, best: quotes[0] ?? null };
}
