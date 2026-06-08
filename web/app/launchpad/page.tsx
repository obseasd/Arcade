"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Search, Sparkles, Rocket } from "lucide-react";
import { PlusIcon } from "@/components/ui/MaskIcon";
import { FEATURED_TOKENS, LAUNCHPAD_CURVE_SUPPLY, LAUNCHPAD_GRADUATION_USDC, LAUNCHPAD_TOTAL_SUPPLY, V4_ENABLED, V4_HOOK_ENABLED } from "@/lib/constants";
import { ARCADE_HOOK_STATUS } from "@/lib/abis/arcadeHook";
import { useLaunchpadTokens, LaunchpadTokenInfo } from "@/lib/hooks/useLaunchpadTokens";
import { useV4LaunchpadTokens } from "@/lib/hooks/useV4LaunchpadTokens";
import { useArcadeHookTokens, type ArcadeHookTokenInfo } from "@/lib/hooks/useArcadeHookTokens";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { parseInlineMetadata } from "@/lib/metadata";
import { TokenCard } from "@/components/launchpad/TokenCard";
import { V4LaunchCard } from "@/components/launchpad/V4LaunchCard";
import { LaunchModeModal } from "@/components/launchpad/LaunchModeModal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

// How many V4 launches to surface in the top strip on /launchpad before the
// user needs to click "View all" to see the dedicated V4 list. Six fits in
// one row on lg breakpoint, three on sm.
const V4_PREVIEW_LIMIT = 6;

type Filter = "all" | "new" | "trending" | "migrating" | "migrated";

export default function LaunchpadIndexPage() {
  const { tokens, isLoading } = useLaunchpadTokens();
  const { tokens: v4Tokens } = useV4LaunchpadTokens();
  const { tokens: v4HookTokens } = useArcadeHookTokens();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // Most-recent V4 launches first, capped at V4_PREVIEW_LIMIT. The
  // dedicated /launchpad/v4/list page exposes the full set with filters.
  const v4Preview = useMemo(() => {
    if (!V4_ENABLED) return [];
    const sorted = v4Tokens.toSorted((a, b) => Number(b.launchedAt - a.launchedAt));
    return sorted.slice(0, V4_PREVIEW_LIMIT);
  }, [v4Tokens]);

  // ArcadeHook (V4 Phase 2) preview strip. Same cap as the prototype strip.
  // We don't have a per-token launchedAt yet in the hook surface (the
  // SnipeConfig.launchedAt is per-token but only populated when snipe is
  // configured), so we fall back to registry order (which is append-only).
  const v4HookPreview = useMemo(() => {
    if (!V4_HOOK_ENABLED) return [];
    return [...v4HookTokens].reverse().slice(0, V4_PREVIEW_LIMIT);
  }, [v4HookTokens]);

  const filtered = useMemo(() => {
    let list: LaunchpadTokenInfo[] = [...tokens];

    // Filter
    if (filter === "new") {
      list = list.filter((t) => !t.migrated && t.tokensSold === 0n);
    } else if (filter === "trending") {
      list = list.filter((t) => !t.migrated && t.tokensSold > 0n).sort((a, b) => Number(b.realUsdcReserve - a.realUsdcReserve));
    } else if (filter === "migrating") {
      list = list.filter((t) => !t.migrated && (t.tokensSold * 100n) / LAUNCHPAD_CURVE_SUPPLY > 80n);
    } else if (filter === "migrated") {
      list = list.filter((t) => t.migrated);
    }

    // Sort default: newest first
    if (filter === "all" || filter === "new") {
      list = list.sort((a, b) => Number(b.createdAt - a.createdAt));
    }

    // Search (name, symbol, address, creator @handle).
    const term = q.trim().toLowerCase().replace(/^@/, "");
    if (term) {
      list = list.filter((t) => {
        if ((t.name ?? "").toLowerCase().includes(term)) return true;
        if ((t.symbol ?? "").toLowerCase().includes(term)) return true;
        if (t.address.toLowerCase().includes(term)) return true;
        const m = parseInlineMetadata(t.metadataURI);
        const handle = m?.creatorTwitter?.toLowerCase();
        if (handle && handle.includes(term)) return true;
        return false;
      });
    }

    // Featured tokens always surface at the top (unless filtered out by status).
    if (FEATURED_TOKENS.size > 0) {
      const featured = list.filter((t) => FEATURED_TOKENS.has(t.address.toLowerCase()));
      const others = list.filter((t) => !FEATURED_TOKENS.has(t.address.toLowerCase()));
      list = [...featured, ...others];
    }
    return list;
  }, [tokens, filter, q]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-3xl font-semibold">Launchpad</h1>
        </div>
        <button type="button"
          onClick={() => setLaunchOpen(true)}
          className="arc-button-primary relative overflow-hidden bg-cover bg-center bg-no-repeat px-5 py-2.5 shadow-[0_10px_30px_-12px_rgba(52,90,120,0.55)] ring-1 ring-arc-cta-hover/40"
          style={{ backgroundImage: "url('/create%20token.png')" }}
        >
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/55 via-black/30 to-black/55" aria-hidden />
          <span className="relative flex items-center gap-2 font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
            <PlusIcon size={16} className="bg-white" /> Launch a token
          </span>
        </button>
      </div>

      {/* V4 strip above the V2/V3 grid - only renders when V4_ENABLED AND
          at least one V4 launch exists. Keeps the existing UX clean for
          users who aren't on a V4-active environment. */}
      {V4_ENABLED && v4Preview.length > 0 && (
        <div className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-arc-text-muted">
              <Sparkles className="h-4 w-4 text-arc-primary" />
              <span className="text-arc-text">V4 launches</span>
              <span className="rounded-md border border-arc-primary/40 bg-arc-primary/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-arc-primary">
                beta
              </span>
            </h2>
            <Link
              href="/launchpad/v4/list"
              className="flex items-center gap-1 text-xs text-arc-text-muted hover:text-arc-text"
            >
              View all
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {v4Preview.map((t) => (
              <V4LaunchCard key={t.address} token={t} nowSec={nowSec} />
            ))}
          </div>
        </div>
      )}

      {/* ArcadeHook (V4 Phase 2) strip. Unified hook stack: 1-step
          createLaunch + atomic graduation + locked LP. Renders only when
          V4_HOOK_ENABLED so the prod UX stays untouched until the hook
          is deployed and addresses land in env. */}
      {V4_HOOK_ENABLED && (
        <div className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-arc-text-muted">
              <Rocket className="h-4 w-4 text-arc-cta-hover" />
              <span className="text-arc-text">ArcadeHook launches</span>
              <span className="rounded-md border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-arc-cta-hover">
                v4
              </span>
            </h2>
            <div className="flex items-center gap-3">
              <Link
                href="/launchpad/v4hook/list"
                className="flex items-center gap-1 text-xs text-arc-text-muted hover:text-arc-text"
              >
                View all
                <ArrowRight className="h-3 w-3" />
              </Link>
              <Link
                href="/launchpad/v4hook/create"
                className="flex items-center gap-1 text-xs text-arc-text-muted hover:text-arc-text"
              >
                New launch
                <PlusIcon size={12} />
              </Link>
            </div>
          </div>
          {v4HookPreview.length === 0 ? (
            <Link
              href="/launchpad/v4hook/create"
              className="block rounded-2xl border border-dashed border-arc-cta-hover/40 bg-arc-cta-hover/5 p-6 text-center text-sm text-arc-text-muted transition-colors hover:border-arc-cta-hover/70 hover:text-arc-text"
            >
              No ArcadeHook launches yet. Be the first to ship a V4 token →
            </Link>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {v4HookPreview.map((t) => (
                <ArcadeHookPreviewCard key={t.address} token={t} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "new", "trending", "migrating", "migrated"] as Filter[]).map((f) => (
            <button type="button"
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                // Same palette as the /positions TabButton (Standard AMM /
                // Concentrated Liquidity / Burned): rounded-xl pill, deep
                // arc-cta-hover blue + white text when active, muted grey
                // surface when not. Replaces the glass white-tinted chip
                // style so the two filter rows read in the same language.
                "rounded-xl border px-4 py-1.5 text-sm font-medium transition-colors",
                filter === f
                  ? "border-arc-gray bg-arc-cta-hover text-white"
                  : "border-arc-border bg-arc-surface text-arc-text-muted hover:bg-arc-surface-2 hover:text-arc-text",
              )}
            >
              {f === "all"
                ? "All"
                : f === "new"
                  ? "New"
                  : f === "trending"
                    ? "Trending"
                    : f === "migrating"
                      ? "About to migrate"
                      : "Migrated"}
            </button>
          ))}
        </div>
        <div className="flex h-11 items-center gap-2 rounded-xl border border-arc-border bg-black/15 px-3 backdrop-blur-xl sm:w-72">
          <Search className="h-4 w-4 text-arc-text-faint" />
          <input
            aria-label="Search launches"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, symbol, address"
            className="arc-input w-full bg-transparent text-sm"
          />
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <SkeletonCard key={i} className="h-48" />
          ))}
        </div>
      )}
      {!isLoading && filtered.length === 0 && (
        <div className="arc-card p-12 text-center text-arc-text-muted">
          No tokens yet.{" "}
          <button type="button" onClick={() => setLaunchOpen(true)} className="text-arc-primary hover:underline">
            Launch the first one →
          </button>
        </div>
      )}
      {!isLoading && filtered.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <TokenCard key={t.address} token={t} curveSupply={LAUNCHPAD_CURVE_SUPPLY} />
          ))}
        </div>
      )}

      <div className="mt-12 text-xs text-arc-text-muted">
        Total supply per launch: {(LAUNCHPAD_TOTAL_SUPPLY / 1_000_000n).toString()}M ·
        Curve supply: 800M · Migration triggers automatically when the curve sells out.
      </div>

      <LaunchModeModal open={launchOpen} onClose={() => setLaunchOpen(false)} />
    </div>
  );
}

// -------------------------------------------------------------------
// ArcadeHook preview card (compact, used in the /launchpad strip)
// -------------------------------------------------------------------

const ARC_HOOK_MODE_LABEL: Record<number, string> = {
  0: "PUMP",
  1: "CLANKER",
  2: "CLANKER V3",
};

function ArcadeHookPreviewCard({ token }: { token: ArcadeHookTokenInfo }) {
  const { image } = useTokenImage(token.address);

  const raisedPct = useMemo(() => {
    if (LAUNCHPAD_GRADUATION_USDC === 0n) return 0;
    const bps = (token.realUsdcReserve * 10_000n) / LAUNCHPAD_GRADUATION_USDC;
    return Math.min(100, Number(bps) / 100);
  }, [token.realUsdcReserve]);

  const tokensSoldPct = useMemo(() => {
    const bps = (token.tokensSold * 10_000n) / LAUNCHPAD_CURVE_SUPPLY;
    return Math.min(100, Number(bps) / 100);
  }, [token.tokensSold]);

  const isGraduated = token.status === ARCADE_HOOK_STATUS.GRADUATED;

  return (
    <Link
      href={`/launchpad/v4hook/${token.address}`}
      className="arc-card group flex flex-col gap-3 p-4 transition-colors hover:border-arc-cta-hover/40"
    >
      <div className="flex items-start gap-3">
        <TokenIcon symbol={token.symbol ?? "?"} image={image} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">
            {token.name ?? "Unnamed"}{" "}
            <span className="text-arc-text-muted">{token.symbol ?? ""}</span>
          </div>
          <div className="mt-0.5 truncate text-[10px] text-arc-text-faint">
            {token.address.slice(0, 8)}...{token.address.slice(-6)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded-md border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-arc-cta-hover">
            {ARC_HOOK_MODE_LABEL[token.mode] ?? "?"}
          </span>
          <span
            className={cn(
              "rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider",
              isGraduated
                ? "border-arc-success/40 bg-arc-success/10 text-arc-success"
                : "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover",
            )}
          >
            {isGraduated ? "Graduated" : "Curving"}
          </span>
        </div>
      </div>

      <div>
        <div className="mb-1 flex justify-between text-[10px] text-arc-text-faint">
          <span>{raisedPct.toFixed(1)}% to graduation</span>
          <span>
            {(Number(token.realUsdcReserve) / 1e6).toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}{" "}
            / 20k USDC
          </span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-arc-bg-elevated">
          <div
            className={cn(
              "absolute left-0 top-0 h-full transition-all",
              isGraduated
                ? "bg-arc-success"
                : "bg-gradient-to-r from-arc-cta to-arc-cta-hover",
            )}
            style={{ width: `${isGraduated ? 100 : raisedPct}%` }}
          />
        </div>
      </div>

      <div className="text-[10px] text-arc-text-faint">
        {tokensSoldPct.toFixed(1)}% of 800M curve supply sold
      </div>
    </Link>
  );
}
