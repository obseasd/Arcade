"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { PlusIcon } from "@/components/ui/MaskIcon";
import { LAUNCHPAD_CURVE_SUPPLY, V4_HOOK_ENABLED } from "@/lib/constants";
import { ARCADE_HOOK_MODE, ARCADE_HOOK_STATUS } from "@/lib/abis/arcadeHook";
import { useLaunchpadTokens } from "@/lib/hooks/useLaunchpadTokens";
import { useArcadeHookTokens } from "@/lib/hooks/useArcadeHookTokens";
import { useV4TokenStatsBatch } from "@/lib/hooks/useV4TokenStatsBatch";
import { useTokenDayVolumes } from "@/lib/hooks/useTokenDayVolumes";
import { useTradeSignals } from "@/lib/hooks/useTradeSignals";
import { V4TokenCard } from "@/components/launchpad/V4TokenCard";
import { LaunchModeModal } from "@/components/launchpad/LaunchModeModal";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

type Filter = "all" | "new" | "trending" | "migrating" | "migrated";

export default function LaunchpadIndexPage() {
  // The grid is the current ArcadeHook (V4) gen only; useLaunchpadTokens is kept
  // solely for its subgraph loading signal so the skeleton timing is unchanged.
  const { isLoading } = useLaunchpadTokens();
  const { tokens: v4HookTokens } = useArcadeHookTokens();
  const v4Addresses = useMemo(() => v4HookTokens.map((t) => t.address), [v4HookTokens]);
  const { statsMap: v4StatsMap } = useV4TokenStatsBatch(v4Addresses);
  // 24h volume (USD) per token from the subgraph TokenDayData, for the volume
  // sorts (Trending / All / Migrated) and the card's "24h Vol" line.
  const { volMap } = useTokenDayVolumes();
  const volOf = (addr: string): number => volMap.get(addr.toLowerCase()) ?? 0;
  // Tier 2 sort signals derived from the Trade entity (blockTime): exact 1h
  // volume (Trending) + last-trade time (All / Migrated). No subgraph change.
  const { vol1h, lastTradeAt } = useTradeSignals();
  const vol1hOf = (addr: string): number => vol1h.get(addr.toLowerCase()) ?? 0;
  const lastTxOf = (addr: string): number => lastTradeAt.get(addr.toLowerCase()) ?? 0;
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);

  // The main grid is the current ArcadeHook (V4) gen ONLY -- one source, so no
  // duplicate cards and no prior-gen / old-bonding-curve tokens leaking in. All
  // tabs are handled here: migrating/migrated apply to graduated PUMPs (CLANKER
  // has no curve, so it never appears under those two).
  const v4Filtered = useMemo(() => {
    if (!V4_HOOK_ENABLED) return [];
    let list = [...v4HookTokens];
    const term = q.trim().toLowerCase().replace(/^@/, "");
    if (term) {
      list = list.filter(
        (t) =>
          (t.name ?? "").toLowerCase().includes(term) ||
          (t.symbol ?? "").toLowerCase().includes(term) ||
          t.address.toLowerCase().includes(term),
      );
    }
    const created = (t: { createdAt: number }) => Number(t.createdAt) || 0;
    const isGraduated = (t: { status: number }) => t.status === ARCADE_HOOK_STATUS.GRADUATED;
    const progressBps = (t: { tokensSold: bigint }) =>
      LAUNCHPAD_CURVE_SUPPLY > 0n ? Number((t.tokensSold * 10_000n) / LAUNCHPAD_CURVE_SUPPLY) : 0;
    if (filter === "new") {
      // Newest to oldest.
      list.sort((a, b) => created(b) - created(a));
    } else if (filter === "trending") {
      // Most 1h volume.
      list = list.filter((t) => vol1hOf(t.address) > 0);
      list.sort((a, b) => vol1hOf(b.address) - vol1hOf(a.address));
    } else if (filter === "migrating") {
      // PUMP curves >= 80% and not yet graduated, closest to migration first.
      // CLANKER has no curve (single-sided from birth) so it never "migrates".
      list = list
        .filter((t) => t.mode === ARCADE_HOOK_MODE.PUMP && !isGraduated(t) && progressBps(t) >= 8_000)
        .sort((a, b) => progressBps(b) - progressBps(a));
    } else if (filter === "migrated") {
      // Graduated PUMPs only (CLANKER is graduated from birth but never migrates
      // from a curve), most recently traded first.
      list = list
        .filter((t) => t.mode === ARCADE_HOOK_MODE.PUMP && isGraduated(t))
        .sort((a, b) => lastTxOf(b.address) - lastTxOf(a.address));
    } else {
      // "all": most recently traded first, newest as the tiebreak.
      list.sort((a, b) => lastTxOf(b.address) - lastTxOf(a.address) || created(b) - created(a));
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v4HookTokens, q, filter, vol1h, lastTradeAt]);

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
      {!isLoading && v4Filtered.length === 0 && (
        <div className="arc-card p-12 text-center text-arc-text-muted">
          No tokens yet.{" "}
          <button type="button" onClick={() => setLaunchOpen(true)} className="text-arc-primary hover:underline">
            Launch the first one →
          </button>
        </div>
      )}
      {!isLoading && v4Filtered.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* The launchpad grid is the current ArcadeHook (V4) gen ONLY -- one
              source, so no duplicates and no prior-gen / old-bonding-curve tokens
              leaking in. Prior-gen tokens stay reachable by direct URL. */}
          {v4Filtered.map((t, i) => (
            <V4TokenCard key={t.address} token={t} priority={i < 6} preloadedStats={v4StatsMap.get(t.address.toLowerCase())} vol24hUsd={volOf(t.address)} />
          ))}
        </div>
      )}

      <LaunchModeModal open={launchOpen} onClose={() => setLaunchOpen(false)} />
    </div>
  );
}
