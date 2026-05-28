"use client";

import { useMemo, useState } from "react";
import { Plus, Search, Star } from "lucide-react";
import { FEATURED_TOKENS, LAUNCHPAD_TOTAL_SUPPLY } from "@/lib/constants";
import { useLaunchpadTokens, LaunchpadTokenInfo } from "@/lib/hooks/useLaunchpadTokens";
import { parseInlineMetadata } from "@/lib/metadata";
import { TokenCard } from "@/components/launchpad/TokenCard";
import { LaunchModeModal } from "@/components/launchpad/LaunchModeModal";
import { cn } from "@/lib/utils";

const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

type Filter = "all" | "new" | "trending" | "migrating" | "migrated";

export default function LaunchpadIndexPage() {
  const { tokens, isLoading } = useLaunchpadTokens();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);

  const filtered = useMemo(() => {
    let list: LaunchpadTokenInfo[] = [...tokens];

    // Filter
    if (filter === "new") {
      list = list.filter((t) => !t.migrated && t.tokensSold === 0n);
    } else if (filter === "trending") {
      list = list.filter((t) => !t.migrated && t.tokensSold > 0n).sort((a, b) => Number(b.realUsdcReserve - a.realUsdcReserve));
    } else if (filter === "migrating") {
      list = list.filter((t) => !t.migrated && (t.tokensSold * 100n) / CURVE_SUPPLY > 80n);
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
          <p className="mt-1 text-sm text-arc-text-muted">
            Launch and trade tokens on Arc&apos;s bonding-curve launchpad. USDC-quoted.
          </p>
        </div>
        <button
          onClick={() => setLaunchOpen(true)}
          className="arc-button-primary relative overflow-hidden bg-cover bg-center bg-no-repeat px-5 py-2.5 shadow-[0_10px_30px_-12px_rgba(52,90,120,0.55)] ring-1 ring-arc-cta-hover/40"
          style={{ backgroundImage: "url('/create%20token.png')" }}
        >
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/55 via-black/30 to-black/55" aria-hidden />
          <span className="relative flex items-center gap-2 font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
            <Plus className="h-4 w-4" /> Launch a token
          </span>
        </button>
      </div>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1">
          {(["all", "new", "trending", "migrating", "migrated"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                filter === f
                  ? "bg-arc-primary text-white"
                  : "text-arc-text-muted hover:bg-arc-surface hover:text-arc-text",
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
        <div className="flex items-center gap-2 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 sm:w-72">
          <Search className="h-4 w-4 text-arc-text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, symbol, address"
            className="arc-input text-sm"
          />
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="arc-card h-48 animate-pulse" />
          ))}
        </div>
      )}
      {!isLoading && filtered.length === 0 && (
        <div className="arc-card p-12 text-center text-arc-text-muted">
          No tokens yet.{" "}
          <button onClick={() => setLaunchOpen(true)} className="text-arc-primary hover:underline">
            Launch the first one →
          </button>
        </div>
      )}
      {!isLoading && filtered.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <TokenCard key={t.address} token={t} curveSupply={CURVE_SUPPLY} />
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
