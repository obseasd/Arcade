"use client";

import { ArrowDown, ArrowUp, ChevronDown, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Address } from "viem";
import { CreatePoolModal } from "@/components/pool/CreatePoolModal";
import { MyPositions } from "@/components/pool/MyPositions";
import { BurnedPositions } from "@/components/pool/BurnedPositions";
import { V3Positions } from "@/components/pool/V3Positions";
import { ClaimAllFeesModal } from "@/components/pool/ClaimAllFeesModal";
import { MaskIcon } from "@/components/ui/MaskIcon";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import type { TokenOption } from "@/components/ui/TokenSelectModal";
import { cn } from "@/lib/utils";

type Tab = "amm" | "burned" | "concentrated";

export interface V3RangeFilter {
    inRange: boolean;
    outOfRange: boolean;
    inactive: boolean;
}

export default function PositionsPage() {
  return (
    <Suspense fallback={null}>
      <PositionsInner />
    </Suspense>
  );
}

function PositionsInner() {
  const sp = useSearchParams();
  const [newOpen, setNewOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("amm");
  // Remount-key nonce: bump after a successful add so MyPositions discards
  // its query cache and re-fetches the pair list. Cheaper than threading a
  // bespoke refetch handle through the tree.
  const [refreshKey, setRefreshKey] = useState(0);
  // Refresh spinner. Flips true on click, auto-clears after a beat so the
  // user gets visual feedback even when the underlying queries already
  // resolve from cache (in which case there's nothing to "wait" for).
  const [refreshing, setRefreshing] = useState(false);
  // Tools row state: search + V3 range filter + claim modal.
  const [search, setSearch] = useState("");
  const [rangeFilter, setRangeFilter] = useState<V3RangeFilter>({
    inRange: true,
    outOfRange: true,
    inactive: false,
  });
  const [rangeMenuOpen, setRangeMenuOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  // Per-list position counts emitted by the child components. Drives the
  // header gating: toolbar + Claim All only render when the active tab
  // has at least one row. Burned has no count callback because it doesn't
  // ship the toolbar.
  const [v2Count, setV2Count] = useState(0);
  const [v3Count, setV3Count] = useState(0);
  const activeCount = tab === "amm" ? v2Count : tab === "concentrated" ? v3Count : 0;
  const showToolbar = activeCount > 0 && (tab === "amm" || tab === "concentrated");
  // Sort key + direction for the small sort dropdown shared with /explore.
  // V2/V3 lists ignore "apr"/"volume" for now (no indexer) and fall back
  // to liquidity / tokenId order; the dropdown still surfaces them so the
  // visual matches /explore.
  type SortKey = "tvl" | "apr" | "volume";
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>("tvl");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [sortOpen, setSortOpen] = useState(false);
  void sortKey;
  void sortDir;
  const rangeBadge = useMemo(() => {
    const count = (rangeFilter.inRange ? 1 : 0) + (rangeFilter.outOfRange ? 1 : 0) + (rangeFilter.inactive ? 1 : 0);
    return `${count} range${count === 1 ? "" : "s"} selected`;
  }, [rangeFilter]);

  // Allow deep links like /positions?tab=concentrated so the V3 mint flow
  // can drop the user directly on their freshly minted NFT row.
  useEffect(() => {
    const t = sp.get("tab");
    if (t === "amm" || t === "burned" || t === "concentrated") setTab(t);
  }, [sp]);

  // Token list passed to CreatePoolModal. Dedupes V2 + V3 catalogs and
  // always surfaces USDC so the modal's pickers have a sane starting set.
  const { tokens: v2Tokens } = useV2Tokens();
  const { tokens: v3Tokens } = useV3Tokens();
  const createPoolTokens: TokenOption[] = useMemo(() => {
    const seen = new Set<string>();
    const out: TokenOption[] = [
      {
        address: ADDRESSES.usdc as Address,
        symbol: "USDC",
        name: "USD Coin",
        decimals: USDC_DECIMALS,
        pinned: true,
      },
    ];
    seen.add(ADDRESSES.usdc.toLowerCase());
    for (const t of [...v2Tokens, ...v3Tokens]) {
      const k = t.address.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
      });
    }
    return out;
  }, [v2Tokens, v3Tokens]);
  // refreshKey is still used to remount the position lists when the user
  // closes the modal (the redirect happens client-side via router.push on
  // /positions/add after a successful add).
  void refreshKey;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Hero - title + description, banner image as background */}
      <div
        className="relative mb-5 overflow-hidden rounded-3xl border border-arc-border"
        style={{
          backgroundImage: "url(/banner.png?v=2)",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        {/* Dark gradient overlay so text stays readable */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/55 to-transparent" />
        <div className="relative p-8 sm:p-10">
          <h1 className="font-display text-4xl font-semibold tracking-tight">
            Your{" "}
            <span className="bg-gradient-to-r from-arc-cta-hover to-arc-primary-hover bg-clip-text text-transparent">
              Positions
            </span>
          </h1>
          <p className="mt-2 max-w-md text-sm text-arc-text-muted">
            Manage your liquidity pools and view your positions.
          </p>
        </div>
      </div>

      {/* Header CTAs: Claim All Fees + New position, right-aligned. Claim
          surfaces only when the V3 tab actually has positions (the action
          is V3-only and would do nothing on an empty list). */}
      <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
        {v3Count > 0 && (
          <button
            onClick={() => setClaimOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-2 text-sm font-semibold text-arc-text transition-colors hover:bg-white/5"
          >
            <Sparkles className="h-4 w-4" />
            Claim All Fees
          </button>
        )}
        <button
          onClick={() => setNewOpen(true)}
          className="arc-button-primary relative overflow-hidden bg-cover bg-center bg-no-repeat px-5 py-2.5 text-base shadow-[0_10px_30px_-12px_rgba(52,90,120,0.55)] ring-1 ring-arc-cta-hover/40"
          style={{ backgroundImage: "url('/create%20token.png')" }}
        >
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/55 via-black/30 to-black/55" aria-hidden />
          <span className="relative flex items-center gap-2 font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
            <Plus className="h-4 w-4" /> New position
          </span>
        </button>
      </div>

      {/* Tabs row + (on V2/V3) the range filter dropdown on the right.
          Mirrors Hyperswap's pattern: tab strip on the left, "X ranges
          selected" pill on the right of the same row. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TabButton active={tab === "amm"} onClick={() => setTab("amm")}>
            Standard AMM
          </TabButton>
          <TabButton
            active={tab === "concentrated"}
            onClick={() => setTab("concentrated")}
          >
            Concentrated Liquidity
          </TabButton>
          <TabButton active={tab === "burned"} onClick={() => setTab("burned")}>
            Burned
          </TabButton>
        </div>
        {tab === "concentrated" && v3Count > 0 && (
          <RangeFilterDropdown
            open={rangeMenuOpen}
            onToggle={() => setRangeMenuOpen((v) => !v)}
            onClose={() => setRangeMenuOpen(false)}
            label={rangeBadge}
            value={rangeFilter}
            onChange={setRangeFilter}
          />
        )}
      </div>

      {/* Tools row: search + sort (filter icon) + refresh. Mirrors the
          /explore control strip so the brand surface stays consistent.
          Gated on the active tab having at least one position. */}
      {showToolbar && (
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-arc-border bg-black/15 px-3 backdrop-blur-xl">
            <Search className="h-4 w-4 text-arc-text-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by token name..."
              className="arc-input w-full bg-transparent text-sm"
            />
          </div>
          <PositionsSortDropdown
            open={sortOpen}
            onToggle={() => setSortOpen((v) => !v)}
            onClose={() => setSortOpen(false)}
            sortKey={sortKey}
            sortDir={sortDir}
            onPick={(k, d) => {
              setSortKey(k);
              setSortDir(d);
              setSortOpen(false);
            }}
          />
          <button
            onClick={() => {
              setRefreshKey((k) => k + 1);
              setRefreshing(true);
              window.setTimeout(() => setRefreshing(false), 700);
            }}
            title="Refresh positions"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-arc-border bg-black/15 text-arc-text backdrop-blur-xl transition-colors hover:bg-white/5"
          >
            <RefreshCw
              className={cn("h-4 w-4", refreshing && "animate-spin")}
            />
          </button>
        </div>
      )}

      {/* Tab content. Keying the lists on refreshKey forces a remount +
          full query re-run after the user adds liquidity or hits Refresh
          so the row appears without a hard reload. */}
      {tab === "amm" && (
        <MyPositions
          key={refreshKey}
          emptyState={<EmptyState />}
          search={search}
          onCountChange={setV2Count}
        />
      )}
      {tab === "concentrated" && (
        <V3Positions
          key={refreshKey}
          search={search}
          rangeFilter={rangeFilter}
          onCountChange={setV3Count}
        />
      )}
      {tab === "burned" && <BurnedPositions />}

      {/* "+ New position" opens the same CreatePoolModal as /explore. Pre-
          fill the pool-type toggle with the tab the user is on so the AMM /
          Concentrated split is honoured without an extra click. Continue
          routes to /positions/add which mounts the full editor (V2 form or
          V3AddLiquidity depending on type). */}
      <CreatePoolModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        defaultPoolType={tab === "concentrated" ? "v3" : "amm"}
        tokens={createPoolTokens}
      />
      <ClaimAllFeesModal
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onSuccess={() => {
          // Bump the V3Positions key so unclaimed fees re-read off-chain
          // after the collect tx confirms.
          setRefreshKey((k) => k + 1);
          setClaimOpen(false);
        }}
      />
    </div>
  );
}

function RangeFilterDropdown({
  open,
  onToggle,
  onClose,
  label,
  value,
  onChange,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  label: string;
  value: V3RangeFilter;
  onChange: (v: V3RangeFilter) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={onToggle}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors",
          open
            ? "border-arc-cta-hover bg-arc-cta-hover/15 text-arc-text"
            : "border-arc-border bg-black/15 text-arc-text-muted hover:bg-white/5 hover:text-arc-text",
        )}
      >
        {label}
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-arc-border bg-black/85 p-1 shadow-arc-card backdrop-blur-2xl">
          <FilterToggle
            label="In range"
            checked={value.inRange}
            onClick={() => onChange({ ...value, inRange: !value.inRange })}
          />
          <FilterToggle
            label="Out of range"
            checked={value.outOfRange}
            onClick={() => onChange({ ...value, outOfRange: !value.outOfRange })}
          />
          <FilterToggle
            label="Inactive"
            description="liquidity == 0"
            checked={value.inactive}
            onClick={() => onChange({ ...value, inactive: !value.inactive })}
          />
        </div>
      )}
    </div>
  );
}

function FilterToggle({
  label,
  description,
  checked,
  onClick,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
    >
      <span className="flex flex-col items-start">
        <span>{label}</span>
        {description && (
          <span className="text-[10px] text-arc-text-faint">{description}</span>
        )}
      </span>
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded border",
          checked
            ? "border-arc-success bg-arc-success/20 text-arc-success"
            : "border-arc-border",
        )}
      >
        {checked && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            className="h-3 w-3"
            fill="currentColor"
          >
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7 7a.75.75 0 01-1.06 0l-3.5-3.5a.75.75 0 011.06-1.06L6.25 10.69l6.47-6.47a.75.75 0 011.06 0z" />
          </svg>
        )}
      </span>
    </button>
  );
}

function TabButton({
  active,
  onClick,
  disabled,
  label,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-xl border px-4 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-arc-gray bg-arc-cta-hover text-white"
          : "border-arc-border bg-arc-surface text-arc-text-muted hover:bg-arc-surface-2 hover:text-arc-text",
        disabled && "cursor-not-allowed opacity-50 hover:bg-arc-surface hover:text-arc-text-muted",
      )}
    >
      {children}
      {label && <span className="ml-2 rounded-full bg-arc-surface-2 px-2 py-0.5 text-[10px]">{label}</span>}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="py-20 text-center">
      <Image
        src="/empty.png"
        alt=""
        width={48}
        height={48}
        className="mx-auto mb-3 h-12 w-12 opacity-50"
      />
      <p className="text-sm text-arc-text-muted">Your V2 liquidity positions will appear here.</p>
    </div>
  );
}

type PositionsSortKey = "tvl" | "apr" | "volume";
type PositionsSortDir = "asc" | "desc";

const POSITIONS_SORT_LABEL: Record<PositionsSortKey, string> = {
  tvl: "TVL",
  apr: "APR",
  volume: "Volume",
};

/**
 * Sort menu matching /explore. Same icon (/filter.png), same dropdown
 * layout, same single-tap-flips-direction behaviour. Keys are advisory
 * for now since V2 / V3 lists fall back to liquidity order until the
 * indexer surfaces APR / Volume.
 */
function PositionsSortDropdown({
  open,
  onToggle,
  onClose,
  sortKey,
  sortDir,
  onPick,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  sortKey: PositionsSortKey;
  sortDir: PositionsSortDir;
  onPick: (k: PositionsSortKey, d: PositionsSortDir) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={onToggle}
        title="Sort"
        aria-expanded={open}
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-arc-border bg-black/15 text-arc-text backdrop-blur-xl transition-colors hover:bg-white/5",
          open && "bg-white/5",
        )}
      >
        <MaskIcon src="/filter.png" size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-44 rounded-xl border border-arc-border bg-black/85 p-1 shadow-arc-card backdrop-blur-2xl">
          {(["tvl", "apr", "volume"] as PositionsSortKey[]).map((k) => {
            const isActive = k === sortKey;
            return (
              <button
                key={k}
                onClick={() => {
                  if (isActive) {
                    onPick(k, sortDir === "desc" ? "asc" : "desc");
                  } else {
                    onPick(k, "desc");
                  }
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-arc-cta-hover/15 text-arc-cta-hover"
                    : "text-arc-text-muted hover:bg-white/5 hover:text-arc-text",
                )}
              >
                <span>{POSITIONS_SORT_LABEL[k]}</span>
                {isActive &&
                  (sortDir === "desc" ? (
                    <ArrowDown className="h-3.5 w-3.5" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" />
                  ))}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
