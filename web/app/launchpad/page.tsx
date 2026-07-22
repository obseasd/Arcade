"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { PlusIcon } from "@/components/ui/MaskIcon";
import { FEATURED_TOKENS, LAUNCHPAD_CURVE_SUPPLY, LAUNCHPAD_TOTAL_SUPPLY, LaunchMode, V4_HOOK_ENABLED } from "@/lib/constants";
import { useLaunchpadTokens, LaunchpadTokenInfo } from "@/lib/hooks/useLaunchpadTokens";
import { getLaunchpadGenerations } from "@/lib/launchpadGenerations";
import { useArcadeHookTokens } from "@/lib/hooks/useArcadeHookTokens";
import { useClankerSortMcaps } from "@/lib/hooks/useClankerSortMcaps";
import { parseInlineMetadata } from "@/lib/metadata";
import { TokenCard } from "@/components/launchpad/TokenCard";
import { V4TokenCard } from "@/components/launchpad/V4TokenCard";
import { LaunchModeModal } from "@/components/launchpad/LaunchModeModal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

type Filter = "all" | "new" | "trending" | "migrating" | "migrated";

export default function LaunchpadIndexPage() {
  const { tokens, isLoading } = useLaunchpadTokens();
  const { tokens: v4HookTokens } = useArcadeHookTokens();
  // Clankers have no bonding curve so their realUsdcReserve is 0 and they
  // sorted last even at a big mcap. This gives USDC-paired Clankers a real
  // sort key = their implied FDV in USDC micros (one multicall over slot0).
  const clankerMcaps = useClankerSortMcaps(tokens);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);

  // ArcadeHook (V4) tokens are shown as regular cards in the main grid (not a
  // separate strip). Registry is append-only, so reverse() = newest first.
  // Search applies; the curve-only filters (migrating/migrated) don't apply to
  // CLANKER (no curve), so V4 tokens are hidden under those tabs.
  const v4Filtered = useMemo(() => {
    if (!V4_HOOK_ENABLED) return [];
    if (filter === "migrated" || filter === "migrating") return [];
    let list = [...v4HookTokens].reverse();
    const term = q.trim().toLowerCase().replace(/^@/, "");
    if (term) {
      list = list.filter(
        (t) =>
          (t.name ?? "").toLowerCase().includes(term) ||
          (t.symbol ?? "").toLowerCase().includes(term) ||
          t.address.toLowerCase().includes(term),
      );
    }
    return list;
  }, [v4HookTokens, q, filter]);

  const filtered = useMemo(() => {
    // HARD filter: the public /launchpad grid only ever surfaces tokens
    // minted on the CURRENT-generation launchpad. Prior generations stay
    // reachable via direct URL (the detail page still probes every
    // generation) and via stats / portfolio surfaces, but they no longer
    // pollute the discovery feed. The operator stance is that anyone who
    // cares about a prior-gen token has a direct link to it; the public
    // feed shows only tokens that can actually be bought right now on
    // the live contract.
    const currentLaunchpad = (
      getLaunchpadGenerations().find((g) => g.isCurrent)?.address ?? ""
    ).toLowerCase();
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
    const isCurrentGen = (t: LaunchpadTokenInfo): boolean => {
      // The hook tags every token with `launchpad` (the contract that
      // minted it). Compare to the current generation's address; the
      // optional `generation` flag is a secondary signal for older
      // hook revs that may still be on the page during a deploy.
      const home = (
        ((t as unknown as { launchpad?: string }).launchpad ?? "") +
        ""
      ).toLowerCase();
      if (home && currentLaunchpad) return home === currentLaunchpad;
      // Fallback: any token with a non-zero creator AND visible name
      // is at least a current-gen candidate. Pure broken-state cards
      // (creator = 0x0, no name) are always dropped.
      const hasCreator =
        !!t.creator && t.creator.toLowerCase() !== ZERO_ADDR;
      return hasCreator && !!t.name;
    };
    let list: LaunchpadTokenInfo[] = tokens.filter(isCurrentGen);

    // Unified market-cap sort key. For curve tokens it's realUsdcReserve
    // (monotonic with mcap on a bonding curve). For USDC-paired Clankers
    // (no curve → reserve 0) it's the implied FDV in USDC micros, so they
    // rank by actual size instead of always sinking to the bottom.
    const mcKey = (t: LaunchpadTokenInfo): bigint =>
      t.mode === 2
        ? clankerMcaps.get(t.address.toLowerCase()) ?? 0n
        : t.realUsdcReserve;

    // Filter
    if (filter === "new") {
      list = list.filter((t) => !t.migrated && t.tokensSold === 0n);
    } else if (filter === "trending") {
      list = list
        .filter((t) => !t.migrated && t.tokensSold > 0n)
        .sort((a, b) => (mcKey(b) > mcKey(a) ? 1 : mcKey(b) < mcKey(a) ? -1 : 0));
    } else if (filter === "migrating") {
      list = list.filter((t) => !t.migrated && (t.tokensSold * 100n) / LAUNCHPAD_CURVE_SUPPLY > 80n);
    } else if (filter === "migrated") {
      // "Migrated" = a PUMP that graduated off its bonding curve into an AMM.
      // CLANKER launches are direct (no curve, no migration), so they never
      // belong here even if their state carries a migrated-like flag.
      list = list.filter((t) => t.migrated && t.mode === LaunchMode.PUMP);
    }

    // Sort. The main "all" view is ordered by market-cap proxy
    // (descending) so the biggest tokens surface first; the "new"
    // filter stays newest-first because that's its whole point.
    //
    // MC proxy = realUsdcReserve: the USDC raised on the bonding curve
    // (or locked at graduation). On a bonding curve price rises with
    // USDC raised, so reserve is monotonic with market cap — it's the
    // best MC signal available on LaunchpadTokenInfo (we don't carry
    // the post-migration V2 pool value here). Ties fall back to
    // newest-first. Compared with bigint operators, not Number(b - a),
    // so a large reserve delta never overflows the 2^53 float range.
    if (filter === "all") {
      list = list.sort((a, b) => {
        const ka = mcKey(a);
        const kb = mcKey(b);
        if (kb > ka) return 1;
        if (kb < ka) return -1;
        return Number(b.createdAt - a.createdAt);
      });
    } else if (filter === "new") {
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
  }, [tokens, filter, q, clankerMcaps]);

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
      {!isLoading && filtered.length === 0 && v4Filtered.length === 0 && (
        <div className="arc-card p-12 text-center text-arc-text-muted">
          No tokens yet.{" "}
          <button type="button" onClick={() => setLaunchOpen(true)} className="text-arc-primary hover:underline">
            Launch the first one →
          </button>
        </div>
      )}
      {!isLoading && (filtered.length > 0 || v4Filtered.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* ArcadeHook (V4) tokens render as regular cards, newest first. */}
          {v4Filtered.map((t, i) => (
            <V4TokenCard key={t.address} token={t} priority={i < 6} />
          ))}
          {filtered.map((t, i) => (
            <TokenCard
              key={t.address}
              token={t}
              curveSupply={LAUNCHPAD_CURVE_SUPPLY}
              // First row of cards gets priority loading so above-the-fold
              // logos appear on first paint instead of after the lazy-load
              // IntersectionObserver fires.
              priority={v4Filtered.length === 0 && i < 6}
            />
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
