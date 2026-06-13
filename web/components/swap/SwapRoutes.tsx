"use client";

import Image from "next/image";
import { Check, Loader2 } from "lucide-react";
import { RouteQuote, PROVIDER_META, ProviderId } from "@/lib/routing/types";
import { formatUnits } from "viem";
import { cn } from "@/lib/utils";

// Logos for every provider. Arcade-internal routes use the brand glyph
// so the route picker reads visually consistent: "this swap is via
// Arcade" looks the same shape as "this swap is via Synthra", instead of
// the previous mix of real DEX logos vs a bare "A" letter. Add a new
// entry here when wiring a new external provider.
const PROVIDER_LOGOS: Partial<Record<ProviderId, string>> = {
  "arcade-v2": "/arcdlogo22.png",
  "arcade-v3": "/arcdlogo22.png",
  "synthra-v3": "/synthra.svg",
  "unitflow-v3": "/unitflow.svg",
  "xylonet-v1": "/xylonet.svg",
};

/**
 * Compact comparison panel: shows the top-N routes (default 3) ranked by
 * amountOut desc. The leading route is highlighted as "Best" and is the
 * one the parent SwapCard executes against by default. The user can tap
 * a non-best route to override the auto-pick — the parent receives the
 * selection via onSelect and re-wires the swap button's executor.
 *
 * Empty state (no quotes after loading) shows a single muted line so the
 * SwapCard does not collapse vertically as the user types. Loading shows
 * a 2-row skeleton block instead of a spinner so the column height is
 * stable while the providers fan out.
 */
interface Props {
  quotes: RouteQuote[];
  loading: boolean;
  /** Currently-active route identifier. Defaults to quotes[0] when null. */
  selected?: RouteQuote;
  onSelect: (q: RouteQuote) => void;
  /** Decimals of tokenOut so we can format amountOut for display. */
  decimalsOut: number;
  /** Symbol of tokenOut for the per-row caption. */
  symbolOut: string;
  /** USD price per whole token of tokenOut. When provided, the routes
   *  panel shows the USD value of each quote (matches Tower / Hyperswap
   *  style) in place of the raw token amount. Undefined falls back to the
   *  raw token amount. */
  usdPricePerOut?: number;
  /** Top-N to display. Default 3. */
  topN?: number;
}

export function SwapRoutes({
  quotes,
  loading,
  selected,
  onSelect,
  decimalsOut,
  symbolOut,
  usdPricePerOut,
  topN = 3,
}: Props) {
  if (loading && quotes.length === 0) {
    return (
      <div className="mt-3 space-y-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-arc-text-faint">
          Routes
        </div>
        <div className="space-y-1.5">
          <div className="h-12 animate-pulse rounded-xl bg-white/[0.03]" />
          <div className="h-12 animate-pulse rounded-xl bg-white/[0.02]" />
        </div>
      </div>
    );
  }

  if (quotes.length === 0) {
    // Empty state. The docstring promised a "single muted line" — the
    // previous `return null` collapsed the column entirely, which made
    // the user think the swap UI was broken whenever every provider
    // came back null (e.g. a V3-classified token with no live pool,
    // or a pair the aggregator does not yet cover). The muted line
    // keeps the column height stable and gives an honest "no route"
    // signal instead of an empty For field with no explanation.
    return (
      <div className="mt-3 space-y-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-arc-text-faint">
          Routes
        </div>
        <div className="rounded-xl border border-arc-border bg-white/[0.015] px-3 py-2.5 text-xs text-arc-text-muted">
          No route found for this pair. Open a USDC pool via{" "}
          <a href="/positions/add" className="text-arc-cta-hover hover:underline">
            /positions/add
          </a>
          {" "}or pick a different output token.
        </div>
      </div>
    );
  }

  const visible = quotes.slice(0, topN);
  const activeAddress = (selected ?? visible[0]).provider;
  const best = visible[0];

  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-arc-text-faint">
          {visible.length === 1 ? "Route" : `Top ${visible.length} routes`}
        </span>
        {loading && (
          <Loader2 className="h-3 w-3 animate-spin text-arc-text-faint" />
        )}
      </div>

      <div className="space-y-1.5">
        {visible.map((q) => {
          const meta = PROVIDER_META[q.provider];
          const active = activeAddress === q.provider;
          const isBest = q === best;
          const deltaBps = isBest
            ? 0
            : Number(
                ((best.amountOut - q.amountOut) * 10_000n) /
                  (best.amountOut === 0n ? 1n : best.amountOut),
              );
          return (
            <button
              key={q.provider}
              type="button"
              onClick={() => onSelect(q)}
              className={cn(
                "group flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-arc-cta-hover/60 bg-arc-cta-hover/10"
                  : "border-arc-border bg-white/[0.015] hover:border-arc-cta-hover/30 hover:bg-white/[0.03]",
              )}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {/* Logo: external DEXs ship their own SVG (non-square
                    aspect ratios — synthra is 14:19, xylonet is 21:14,
                    unitflow is 16:15) so we render at 28px square with
                    object-contain to preserve them. unoptimized: true
                    is required for Next.js to serve raw SVG without
                    re-encoding to PNG. Arcade routes keep the circular
                    chrome with an initial letter. */}
                {PROVIDER_LOGOS[q.provider] ? (
                  <div
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center",
                      active && "drop-shadow-[0_0_6px_rgba(120,180,255,0.4)]",
                    )}
                  >
                    <Image
                      src={PROVIDER_LOGOS[q.provider]!}
                      alt={meta.label}
                      width={28}
                      height={28}
                      unoptimized
                      className="h-7 w-7 object-contain"
                    />
                  </div>
                ) : (
                  <div
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                      active
                        ? "border-arc-cta-hover bg-arc-cta-hover/20"
                        : "border-arc-border bg-black/30",
                    )}
                  >
                    {active ? (
                      <Check className="h-3.5 w-3.5 text-arc-cta-hover" />
                    ) : (
                      <span className={cn("text-[10px] font-bold uppercase", meta.accent)}>
                        {meta.label.slice(0, 1)}
                      </span>
                    )}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-arc-text">
                    <span className="truncate">{meta.label}</span>
                    {isBest && (
                      <span className="rounded bg-emerald-400/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-400">
                        Best
                      </span>
                    )}
                  </div>
                  {q.pathLabel && (
                    <div className="truncate text-[10px] text-arc-text-faint">{q.pathLabel}</div>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold tabular-nums text-arc-text">
                  {usdPricePerOut !== undefined
                    ? formatUsd(q.amountOut, decimalsOut, usdPricePerOut)
                    : (
                      <>
                        {formatAmount(q.amountOut, decimalsOut)}{" "}
                        <span className="text-[10px] font-medium text-arc-text-faint">{symbolOut}</span>
                      </>
                    )}
                </div>
                {!isBest && deltaBps > 0 && (
                  <div className="text-[10px] tabular-nums text-arc-warn">
                    -{(deltaBps / 100).toFixed(2)}%
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatAmount(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return "0";
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (n >= 0.0001) return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return n.toExponential(2);
}

function formatUsd(raw: bigint, decimals: number, usdPerToken: number): string {
  const tokens = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(tokens)) return "$0.00";
  const usd = tokens * usdPerToken;
  if (usd >= 1) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd > 0) return `$${usd.toFixed(5)}`;
  return "$0.00";
}
