"use client";

import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    Flame,
    Plus,
    Search,
    Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CreatePoolModal } from "@/components/pool/CreatePoolModal";
import {
    Area,
    AreaChart,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
} from "recharts";
import { Address, formatUnits } from "viem";
import { useReadContracts } from "wagmi";

import { PAIR_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useLaunchpadTokens } from "@/lib/hooks/useLaunchpadTokens";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { useV3FactoryPools } from "@/lib/hooks/useV3FactoryPools";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

const USDC_LOWER = ADDRESSES.usdc.toLowerCase();

// Palette used by every chart so the cards read as a single visual family.
const TOTAL_COLOR = "#2f7fd6"; // arc-cta blue
const V3_COLOR = "#a855f7"; // purple
const V2_COLOR = "#06b6d4"; // cyan

type Win = "7D" | "30D" | "90D";
type Filter =
    | "all"
    | "hyped"
    | "points"
    | "incentivized"
    | "standard-amm"
    | "concentrated";
type ViewMode = "list" | "card";

const FILTERS: { value: Filter; label: string; icon?: React.ReactNode }[] = [
    { value: "all", label: "All" },
    {
        value: "hyped",
        label: "Hyped Pools",
        icon: <Flame className="h-3.5 w-3.5 text-arc-warn" />,
    },
    {
        value: "points",
        label: "Points Program",
        icon: <Sparkles className="h-3.5 w-3.5 text-arc-cta-hover" />,
    },
    {
        value: "incentivized",
        label: "Incentivized & Liquidity Mining",
        icon: <span className="text-xs">🚀</span>,
    },
    { value: "standard-amm", label: "Standard AMM" },
    { value: "concentrated", label: "Concentrated Liquidity" },
];

interface PoolPairRow {
    key: string;
    token0: { address: Address; symbol: string };
    token1: { address: Address; symbol: string };
    subRows: PoolSubRow[];
    tvlUsdc: bigint;
    /** Pool-level APR percentage (eg. 120.5 means 120.5%). Undefined until
     *  ArcLens lands; "Hyped" derives from this >100% rule, so until then
     *  the Hyped filter returns no pools (rather than guessing).  */
    aprPct?: number;
    isIncentivized: boolean;
}

interface PoolSubRow {
    address: Address;
    version: "v2" | "v3";
    feeBps: number;
    tvlUsdc: bigint;
}

export default function ExplorePage() {
    const { pairs: v2Pairs, tokens: v2Tokens } = useV2Tokens();
    const { tokens: v3Tokens, feeOf: v3FeeOf } = useV3Tokens();
    // Manually-created V3 pools (not launchpad-driven). USDC/SeedETH style
    // pools land here so they appear in the explore list alongside the
    // launchpad's locked-LP CLANKER_V3 pools.
    const { pools: v3FactoryPools } = useV3FactoryPools();
    const { tokens: launchpadTokens } = useLaunchpadTokens();

    const [filter, setFilter] = useState<Filter>("all");
    const [q, setQ] = useState("");
    const [tvlWindow, setTvlWindow] = useState<Win>("30D");
    const [volWindow, setVolWindow] = useState<Win>("30D");
    const [feeWindow, setFeeWindow] = useState<Win>("30D");
    const [expanded, setExpanded] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>("list");
    const [page, setPage] = useState(1);
    const [createOpen, setCreateOpen] = useState(false);
    const PAGE_SIZE = 10;

    const reservesQ = useReadContracts({
        contracts: v2Pairs.flatMap((p) => [
            { address: p, abi: PAIR_ABI, functionName: "getReserves" as const },
            { address: p, abi: PAIR_ABI, functionName: "token0" as const },
            { address: p, abi: PAIR_ABI, functionName: "token1" as const },
        ]),
        query: { enabled: v2Pairs.length > 0 },
    });

    const tokenLookup = useMemo(() => {
        const m = new Map<string, { symbol: string; decimals: number }>();
        m.set(USDC_LOWER, { symbol: "USDC", decimals: USDC_DECIMALS });
        for (const t of v2Tokens) {
            m.set(t.address.toLowerCase(), {
                symbol: t.symbol ?? "TOKEN",
                decimals: t.decimals ?? 18,
            });
        }
        for (const t of v3Tokens) {
            const k = t.address.toLowerCase();
            if (!m.has(k))
                m.set(k, { symbol: t.symbol ?? "TOKEN", decimals: t.decimals ?? 18 });
        }
        return m;
    }, [v2Tokens, v3Tokens]);

    // Hyped: pools whose APR exceeds 100%. APR is indexer-sourced and
    // currently undefined for every row, so the filter intentionally returns
    // nothing until that data lands. Keeping launchpad tokens here as a
    // suppressed reference until the real APR map is wired.
    void launchpadTokens;

    const allRows: PoolPairRow[] = useMemo(() => {
        const grouped = new Map<string, PoolPairRow>();

        if (reservesQ.data) {
            for (let i = 0; i < v2Pairs.length; i++) {
                const reservesRes = reservesQ.data[3 * i];
                const t0Res = reservesQ.data[3 * i + 1];
                const t1Res = reservesQ.data[3 * i + 2];
                if (
                    reservesRes?.status !== "success" ||
                    t0Res?.status !== "success" ||
                    t1Res?.status !== "success"
                )
                    continue;
                const [r0, r1] = reservesRes.result as readonly [bigint, bigint, number];
                const t0 = (t0Res.result as Address).toLowerCase();
                const t1 = (t1Res.result as Address).toLowerCase();

                let tvlUsdc = 0n;
                if (t0 === USDC_LOWER) tvlUsdc = r0 * 2n;
                else if (t1 === USDC_LOWER) tvlUsdc = r1 * 2n;

                const ka = t0 < t1 ? t0 : t1;
                const kb = t0 < t1 ? t1 : t0;
                const key = `${ka}|${kb}`;
                const aMeta = tokenLookup.get(ka);
                const bMeta = tokenLookup.get(kb);

                if (!grouped.has(key)) {
                    grouped.set(key, {
                        key,
                        token0: { address: ka as Address, symbol: aMeta?.symbol ?? "?" },
                        token1: { address: kb as Address, symbol: bMeta?.symbol ?? "?" },
                        subRows: [],
                        tvlUsdc: 0n,
                        aprPct: undefined,
                        isIncentivized: false,
                    });
                }
                const row = grouped.get(key)!;
                row.subRows.push({
                    address: v2Pairs[i],
                    version: "v2",
                    feeBps: 30,
                    tvlUsdc,
                });
                row.tvlUsdc += tvlUsdc;
            }
        }

        for (const t of v3Tokens) {
            const ka = USDC_LOWER < t.address.toLowerCase() ? USDC_LOWER : t.address.toLowerCase();
            const kb = USDC_LOWER < t.address.toLowerCase() ? t.address.toLowerCase() : USDC_LOWER;
            const key = `${ka}|${kb}`;
            const aMeta = tokenLookup.get(ka);
            const bMeta = tokenLookup.get(kb);

            if (!grouped.has(key)) {
                grouped.set(key, {
                    key,
                    token0: { address: ka as Address, symbol: aMeta?.symbol ?? "?" },
                    token1: { address: kb as Address, symbol: bMeta?.symbol ?? "?" },
                    subRows: [],
                    tvlUsdc: 0n,
                    aprPct: undefined,
                    isIncentivized: false,
                });
            }
            const row = grouped.get(key)!;
            row.subRows.push({
                address: t.address,
                version: "v3",
                feeBps: Math.round(v3FeeOf(t.address) / 100),
                tvlUsdc: 0n,
            });
        }

        // Manually-created V3 pools (factory.getPool enumeration). The same
        // pair key joins them with their V2 sibling when one exists, so
        // USDC/SeedETH lands on the same row regardless of which version
        // the user opened first. Dedup against launchpad CLANKER_V3 pools
        // by (token, feePip).
        for (const fp of v3FactoryPools) {
            const ka = USDC_LOWER < fp.token.toLowerCase() ? USDC_LOWER : fp.token.toLowerCase();
            const kb = USDC_LOWER < fp.token.toLowerCase() ? fp.token.toLowerCase() : USDC_LOWER;
            const key = `${ka}|${kb}`;
            const aMeta = tokenLookup.get(ka);
            const bMeta = tokenLookup.get(kb);

            if (!grouped.has(key)) {
                grouped.set(key, {
                    key,
                    token0: { address: ka as Address, symbol: aMeta?.symbol ?? "?" },
                    token1: { address: kb as Address, symbol: bMeta?.symbol ?? "?" },
                    subRows: [],
                    tvlUsdc: 0n,
                    aprPct: undefined,
                    isIncentivized: false,
                });
            }
            const row = grouped.get(key)!;
            // Skip dup if the launchpad already surfaced this exact pool at
            // the same fee tier (matches by sub-row address since the V3
            // launchpad row's `address` is the underlying token, not the
            // pool - so compare on token + fee instead).
            const dup = row.subRows.some(
                (s) =>
                    s.version === "v3" &&
                    s.address.toLowerCase() === fp.token.toLowerCase() &&
                    s.feeBps === Math.round(fp.feePip / 100),
            );
            if (dup) continue;
            row.subRows.push({
                address: fp.token,
                version: "v3",
                feeBps: Math.round(fp.feePip / 100),
                tvlUsdc: 0n,
            });
        }

        return Array.from(grouped.values());
    }, [v2Pairs, reservesQ.data, v3Tokens, v3FeeOf, v3FactoryPools, tokenLookup]);

    const filteredRows = useMemo(() => {
        let rows = allRows;
        if (filter === "hyped")
            rows = rows.filter((r) => r.aprPct !== undefined && r.aprPct > 100);
        else if (filter === "incentivized") rows = rows.filter((r) => r.isIncentivized);
        else if (filter === "standard-amm")
            rows = rows.filter((r) => r.subRows.some((s) => s.version === "v2"));
        else if (filter === "concentrated")
            rows = rows.filter((r) => r.subRows.some((s) => s.version === "v3"));
        else if (filter === "points") rows = [];

        const term = q.trim().toLowerCase();
        if (term) {
            rows = rows.filter(
                (r) =>
                    r.token0.symbol.toLowerCase().includes(term) ||
                    r.token1.symbol.toLowerCase().includes(term) ||
                    r.token0.address.toLowerCase().includes(term) ||
                    r.token1.address.toLowerCase().includes(term),
            );
        }
        return rows.slice().sort((a, b) => (b.tvlUsdc > a.tvlUsdc ? 1 : -1));
    }, [allRows, filter, q]);

    /**
     * Auto-switch to card view when a non-"all" filter narrows the list to
     * fewer than 10 pools. Tapping the view-mode toggle still overrides this
     * (the effect only fires on filter/count changes).
     */
    useEffect(() => {
        if (filter !== "all" && filteredRows.length > 0 && filteredRows.length < 10) {
            setViewMode("card");
        } else if (filter === "all") {
            setViewMode("list");
        }
    }, [filter, filteredRows.length]);

    // Reset to page 1 whenever the filter, search, or view mode resets the
    // visible set so the user never lands on an empty (past-the-end) page.
    useEffect(() => {
        setPage(1);
    }, [filter, q, viewMode]);

    const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
    const pageRows = useMemo(
        () => filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        [filteredRows, page],
    );

    const totalTvlUsdc = useMemo(
        () => allRows.reduce((acc, r) => acc + r.tvlUsdc, 0n),
        [allRows],
    );

    const { tvlV2, tvlV3 } = useMemo(() => {
        let v2 = 0n;
        let v3 = 0n;
        for (const row of allRows) {
            for (const sub of row.subRows) {
                if (sub.version === "v2") v2 += sub.tvlUsdc;
                else v3 += sub.tvlUsdc;
            }
        }
        return { tvlV2: v2, tvlV3: v3 };
    }, [allRows]);

    return (
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
            {/* Hero header: brighter gradient + side bloom, no border */}
            <div className="relative mb-6 overflow-hidden rounded-2xl bg-gradient-to-br from-arc-cta/35 via-arc-cta/15 to-arc-cta-hover/30 p-6 sm:p-8">
                <div
                    aria-hidden
                    className="pointer-events-none absolute -left-12 -top-20 h-72 w-72 rounded-full bg-arc-cta-hover/35 blur-3xl"
                />
                <div
                    aria-hidden
                    className="pointer-events-none absolute -right-10 -bottom-20 h-72 w-72 rounded-full bg-arc-cta/40 blur-3xl"
                />
                <div className="relative z-10">
                    <h1 className="text-3xl font-semibold sm:text-4xl">
                        Explore{" "}
                        <span className="bg-gradient-to-r from-arc-cta-hover to-[#8ecbff] bg-clip-text text-transparent">
                            Pools
                        </span>
                    </h1>
                    <p className="mt-2 text-sm text-arc-text-muted sm:text-base">
                        Discover all Liquidity Pools on Arcade.
                    </p>
                </div>
            </div>

            {/* Hero stats: 3 cards with sparkline + hover tooltip */}
            <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
                <ChartCard
                    label="TVL"
                    valueUsdc={totalTvlUsdc}
                    v2Usdc={tvlV2}
                    v3Usdc={tvlV3}
                    window={tvlWindow}
                    onWindow={setTvlWindow}
                    singleLine
                />
                <ChartCard
                    label="Volume"
                    valueUsdc={0n}
                    v2Usdc={0n}
                    v3Usdc={0n}
                    window={volWindow}
                    onWindow={setVolWindow}
                />
                <ChartCard
                    label="Generated Fees"
                    valueUsdc={0n}
                    v2Usdc={0n}
                    v3Usdc={0n}
                    window={feeWindow}
                    onWindow={setFeeWindow}
                />
            </div>

            {/* + New position - opens the Create-a-new-pool modal */}
            <div className="mb-4 flex justify-end">
                <button
                    onClick={() => setCreateOpen(true)}
                    className="inline-flex items-center gap-2 rounded-xl bg-arc-cta px-[1.1rem] py-[0.55rem] text-[0.9625rem] font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                >
                    <Plus className="h-[1.1rem] w-[1.1rem]" />
                    New position
                </button>
            </div>

            {/* Filter chips */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                    {FILTERS.map((f) => (
                        <button
                            key={f.value}
                            onClick={() => setFilter(f.value)}
                            className={cn(
                                "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium text-arc-text backdrop-blur-xl transition-colors",
                                filter === f.value
                                    ? "border-arc-cta-hover bg-arc-cta-hover/15"
                                    : "border-arc-border bg-black/15 hover:border-arc-cta-hover/40",
                            )}
                        >
                            {f.icon}
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>
            {/* Search + sort + view-mode toggle. Both icon buttons are perfect
                squares (h-11 w-11), and the search bar matches that height so
                the row reads as a uniform 44-px control strip. */}
            <div className="mb-4 flex items-center gap-2">
                <div className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-arc-border bg-black/15 px-3 backdrop-blur-xl">
                    <Search className="h-4 w-4 text-arc-text-faint" />
                    <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search by token name..."
                        className="arc-input w-full bg-transparent text-sm"
                    />
                </div>
                <button
                    title="Sort"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-arc-border bg-black/15 text-arc-text backdrop-blur-xl transition-colors hover:bg-white/5"
                >
                    <MaskIcon src="/filter.png" size={16} />
                </button>
                <button
                    title={viewMode === "list" ? "Switch to card view" : "Switch to list view"}
                    onClick={() =>
                        setViewMode((m) => (m === "list" ? "card" : "list"))
                    }
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-arc-border bg-black/15 text-arc-text backdrop-blur-xl transition-colors hover:bg-white/5"
                >
                    <MaskIcon
                        src={viewMode === "list" ? "/viewcard.png" : "/viewligne.png"}
                        size={16}
                    />
                </button>
            </div>

            {/* Pool list / grid */}
            {reservesQ.isLoading && (
                <div className="space-y-3">
                    {[...Array(6)].map((_, i) => (
                        <SkeletonCard key={i} className="h-20" />
                    ))}
                </div>
            )}
            {!reservesQ.isLoading && filteredRows.length === 0 && (
                <div className="arc-card p-12 text-center text-sm text-arc-text-muted">
                    No pools match the current filter.
                </div>
            )}
            {!reservesQ.isLoading && filteredRows.length > 0 && viewMode === "list" && (
                <div className="space-y-3 pt-2">
                    {pageRows.map((row) => (
                        <PoolPairRowCard
                            key={row.key}
                            row={row}
                            expanded={expanded === row.key}
                            onToggle={() =>
                                setExpanded((p) => (p === row.key ? null : row.key))
                            }
                        />
                    ))}
                </div>
            )}
            {!reservesQ.isLoading && filteredRows.length > 0 && viewMode === "card" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {pageRows.map((row) => (
                        <PoolPairGridCard key={row.key} row={row} />
                    ))}
                </div>
            )}
            {!reservesQ.isLoading && pageCount > 1 && (
                <Pagination page={page} pageCount={pageCount} onPage={setPage} />
            )}

            <p className="mt-10 text-center text-xs text-arc-text-faint">
                Historical volume + APR + Daily Fees charts ship with the ArcLens indexer
                (Circle Grant Milestone 3). For now the page surfaces a live TVL snapshot
                across every Arcade pool plus the categorisation infrastructure.
            </p>

            {/* Create-a-new-pool modal. Defaults to the highest-TVL pair so the
                user lands on the existing flagship pool without having to pick. */}
            <CreatePoolModal
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                defaultPair={
                    allRows.length > 0
                        ? { token0: allRows[0].token0, token1: allRows[0].token1 }
                        : undefined
                }
                tokens={Array.from(tokenLookup.entries()).map(([addr, meta]) => ({
                    address: addr as Address,
                    symbol: meta.symbol,
                    decimals: meta.decimals,
                }))}
            />
        </div>
    );
}

// -------------------------------------------------------------------
// Hero stat card with sparkline + hover tooltip (Total / V3 / V2).
// TVL uses singleLine so only the total trace renders, and the tooltip
// surfaces a single TVL row instead of the split.
// -------------------------------------------------------------------

function ChartCard({
    label,
    valueUsdc,
    v2Usdc,
    v3Usdc,
    window,
    onWindow,
    singleLine,
}: {
    label: string;
    valueUsdc: bigint;
    v2Usdc: bigint;
    v3Usdc: bigint;
    window: Win;
    onWindow: (w: Win) => void;
    singleLine?: boolean;
}) {
    const totalUsd = Number(valueUsdc) / 1e6;
    const v2Usd = Number(v2Usdc) / 1e6;
    const v3Usd = Number(v3Usdc) / 1e6;

    /**
     * Series anchored on today so the tooltip can show real dates instead of
     * "Day -N". Once the indexer is wired the synthetic curve gets replaced
     * by actual timeseries reads and this shape stays the same.
     */
    const series = useMemo(() => {
        const totalDays = window === "7D" ? 7 : window === "30D" ? 30 : 90;
        const points =
            window === "7D" ? 28 : window === "30D" ? 30 : 60;
        const stepDays = totalDays / (points - 1);
        const today = new Date();
        const out: {
            x: number;
            total: number;
            v3: number;
            v2: number;
            label: string;
        }[] = [];
        for (let i = 0; i < points; i++) {
            const noise = Math.sin(i * 0.4) * 0.06;
            const slope = (i / points) * 0.85;
            const t = 0.18 + slope + noise;
            const v3 = t * 0.7;
            const v2 = t * 0.3;
            const date = new Date(
                today.getTime() - (points - 1 - i) * stepDays * 86_400_000,
            );
            out.push({
                x: i,
                total: t,
                v3,
                v2,
                label: date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                }),
            });
        }
        return out;
    }, [window]);

    // Prepend "$" so the hero TVL/Volume/Fees numbers read as money. The
    // formatBig helper handles K/M suffixes; we add the dollar sign once at
    // the call site so the empty-state "—" stays untouched.
    const valueLabel = useMemo(() => {
        const inner = formatBig(totalUsd);
        return inner === "—" ? "—" : `$${inner}`;
    }, [totalUsd]);
    const slug = label.replace(/\s+/g, "-").toLowerCase();
    const fillId = `chart-fill-${slug}`;
    const shimmerTotalId = `shimmer-${slug}-total`;
    const shimmerV3Id = `shimmer-${slug}-v3`;
    const shimmerV2Id = `shimmer-${slug}-v2`;

    return (
        <div className="relative h-[12.1rem] overflow-hidden rounded-2xl border border-arc-border bg-black/15 p-4 backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-start gap-3">
                <span className="text-xs uppercase tracking-wider text-arc-text-muted">
                    {label}
                </span>
                {/* Timeframe picker: directly after the label, max-rounded pill
                    with a taller selected highlight per design. Each button is
                    ~10% larger than the previous spec. */}
                <div className="flex items-center gap-1">
                    {(["7D", "30D", "90D"] as Win[]).map((w) => (
                        <button
                            key={w}
                            onClick={() => onWindow(w)}
                            className={cn(
                                "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors",
                                window === w
                                    ? "bg-arc-cta text-white"
                                    : "text-arc-text-muted hover:text-arc-text",
                            )}
                        >
                            {w}
                        </button>
                    ))}
                </div>
            </div>
            <div className="absolute right-4 top-3 text-[1.35rem] font-semibold tabular-nums sm:text-[1.7rem]">
                {valueLabel}
            </div>
            <div className="absolute inset-x-0 bottom-0 h-24">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={series} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
                        <defs>
                            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={TOTAL_COLOR} stopOpacity={0.45} />
                                <stop offset="100%" stopColor={TOTAL_COLOR} stopOpacity={0} />
                            </linearGradient>
                            {/* Animated shimmer gradients: a 50%-positioned bright
                                stop slides across the bounding box via animateTransform,
                                producing a moving glint along every line. Each line
                                gets its own gradient so the colours stay distinct. */}
                            <ShimmerGradient id={shimmerTotalId} color={TOTAL_COLOR} />
                            <ShimmerGradient id={shimmerV3Id} color={V3_COLOR} />
                            <ShimmerGradient id={shimmerV2Id} color={V2_COLOR} />
                        </defs>
                        <RechartsTooltip
                            cursor={{ stroke: TOTAL_COLOR, strokeOpacity: 0.4, strokeWidth: 1 }}
                            content={(p) => (
                                <ChartTooltip
                                    payload={p.payload}
                                    singleLine={singleLine}
                                    label={label}
                                    totalUsd={totalUsd}
                                    v3Usd={v3Usd}
                                    v2Usd={v2Usd}
                                />
                            )}
                        />
                        {!singleLine && (
                            <Area
                                type="monotone"
                                dataKey="v2"
                                stroke={`url(#${shimmerV2Id})`}
                                fill="transparent"
                                strokeWidth={1.4}
                                isAnimationActive={false}
                                dot={false}
                            />
                        )}
                        {!singleLine && (
                            <Area
                                type="monotone"
                                dataKey="v3"
                                stroke={`url(#${shimmerV3Id})`}
                                fill="transparent"
                                strokeWidth={1.4}
                                isAnimationActive={false}
                                dot={false}
                            />
                        )}
                        <Area
                            type="monotone"
                            dataKey="total"
                            stroke={`url(#${shimmerTotalId})`}
                            fill={`url(#${fillId})`}
                            strokeWidth={2.2}
                            isAnimationActive={false}
                            dot={false}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}

function ChartTooltip({
    payload,
    singleLine,
    label,
    totalUsd,
    v3Usd,
    v2Usd,
}: {
    payload: ReadonlyArray<{ payload?: { total: number; v3: number; v2: number; label: string } }> | undefined;
    singleLine?: boolean;
    label: string;
    totalUsd: number;
    v3Usd: number;
    v2Usd: number;
}) {
    const point = payload?.[0]?.payload;
    if (!point) return null;
    // Scale the synthetic 0-1 curve to the actual snapshot so the numbers
    // displayed on hover trend along with the line.
    const tot = totalUsd > 0 ? point.total * (totalUsd / Math.max(point.total, 0.01)) : 0;
    const v3 = v3Usd > 0 ? point.v3 * (v3Usd / Math.max(point.v3, 0.01)) : 0;
    const v2 = v2Usd > 0 ? point.v2 * (v2Usd / Math.max(point.v2, 0.01)) : 0;
    return (
        <div className="rounded-xl border border-arc-border bg-black/30 px-3 py-2 text-xs shadow-arc-card backdrop-blur-xl">
            <div className="mb-1 text-arc-text-muted">{point.label}</div>
            <div className="space-y-0.5">
                {singleLine ? (
                    <Row label={label} value={tot} color={TOTAL_COLOR} />
                ) : (
                    <>
                        <Row label="Total" value={tot} color={TOTAL_COLOR} />
                        <Row label="V3" value={v3} color={V3_COLOR} />
                        <Row label="V2" value={v2} color={V2_COLOR} />
                    </>
                )}
            </div>
        </div>
    );
}

function Row({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div className="flex items-center justify-between gap-4 tabular-nums">
            <span className="flex items-center gap-1.5" style={{ color }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                {label}
            </span>
            <span className="font-semibold text-arc-text">
                {value > 0 ? `$${formatBig(value)}` : "—"}
            </span>
        </div>
    );
}

// -------------------------------------------------------------------
// Pool pair row (list view; expand to see sub-pools)
// -------------------------------------------------------------------

function PoolPairRowCard({
    row,
    expanded,
    onToggle,
}: {
    row: PoolPairRow;
    expanded: boolean;
    onToggle: () => void;
}) {
    const { image: image0 } = useTokenImage(row.token0.address);
    const { image: image1 } = useTokenImage(row.token1.address);

    const tvlLabel = useMemo(() => formatUsd(row.tvlUsdc), [row.tvlUsdc]);
    const subCount = row.subRows.length;

    return (
        <div className="relative">
            {/* "LP Boost" sticker - sits on top of the row border for any pool
                tagged Incentivized & Liquidity Mining. Green outline + soft
                glow mirrors HyperSwap's badge, adapted to Arcade's palette
                via arc-success (emerald). */}
            {row.isIncentivized && (
                <div className="absolute -top-2.5 left-4 z-10 inline-flex items-center gap-1 rounded-md border border-arc-success bg-arc-bg-elevated px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-arc-success">
                    <Sparkles className="h-2.5 w-2.5" />
                    LP Boost
                </div>
            )}
            <div
                className={cn(
                    "arc-card overflow-hidden p-0 transition-colors",
                    expanded && "border-arc-cta-hover/30",
                    row.isIncentivized &&
                        "border-arc-success/70 shadow-[0_0_20px_-4px_rgba(16,185,129,0.45)] ring-1 ring-arc-success/40",
                )}
            >
            {/* Row header. +10% taller than the previous spec (1.1rem -> 1.21rem). */}
            <div className="flex flex-col items-stretch gap-3 p-[1.21rem] sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex -space-x-2">
                        <TokenIcon
                            symbol={row.token0.symbol}
                            image={image0}
                            size={40}
                        />
                        <TokenIcon
                            symbol={row.token1.symbol}
                            image={image1}
                            size={40}
                        />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                            {row.token0.symbol} / {row.token1.symbol}
                        </div>
                        {row.aprPct !== undefined && row.aprPct > 100 && (
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <span className="inline-flex items-center gap-1 rounded-md border border-arc-warn/40 bg-arc-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-arc-warn">
                                    <Flame className="h-2.5 w-2.5" />
                                    Hyped
                                </span>
                            </div>
                        )}
                    </div>
                </div>
                <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
                    <Metric label="Best APR" value="—" pendingIndexer />
                    <Metric label="Daily Fees" value="—" pendingIndexer />
                    <Metric label="TVL" value={tvlLabel} />
                    <Metric label="1D Volume" value="—" pendingIndexer />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Link
                        href="/swap"
                        className="inline-flex items-center gap-1.5 rounded-xl border border-arc-border bg-sky-400/10 px-3 py-[0.575rem] text-xs font-semibold text-sky-400 transition-colors hover:bg-sky-400/20"
                    >
                        <SwapIcon />
                        Swap
                    </Link>
                    <button
                        onClick={onToggle}
                        className="inline-flex items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-[0.575rem] text-xs font-medium text-arc-text transition-colors hover:bg-white/5"
                    >
                        {expanded ? "Hide pools" : `Show all pools (${subCount})`}
                        <ChevronDown
                            className={cn(
                                "h-3.5 w-3.5 transition-transform",
                                expanded && "rotate-180",
                            )}
                        />
                    </button>
                </div>
            </div>

            {expanded && (
                <div className="border-t border-arc-border bg-white/[0.015]">
                    <div className="hidden grid-cols-[1fr_repeat(4,_1fr)_auto] gap-3 px-4 py-2 text-[10px] uppercase tracking-wider text-arc-text-faint sm:grid">
                        <span>Pools ({subCount})</span>
                        <span className="text-right">APR</span>
                        <span className="text-right">Daily Fees</span>
                        <span className="text-right">TVL</span>
                        <span className="text-right">1D Volume</span>
                        <span />
                    </div>
                    {row.subRows.map((sub) => (
                        <PoolSubRowCard
                            key={`${sub.address}-${sub.version}`}
                            sub={sub}
                            token0={row.token0}
                            token1={row.token1}
                            image0={image0}
                            image1={image1}
                        />
                    ))}
                </div>
            )}
            </div>
        </div>
    );
}

function PoolSubRowCard({
    sub,
    token0,
    token1,
    image0,
    image1,
}: {
    sub: PoolSubRow;
    token0: { address: Address; symbol: string };
    token1: { address: Address; symbol: string };
    image0?: string;
    image1?: string;
}) {
    const feeLabel = `${sub.feeBps / 100}%`;
    const tvlLabel = formatUsd(sub.tvlUsdc);
    return (
        <div className="grid grid-cols-1 items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_repeat(4,_1fr)_auto]">
            <div className="flex items-center gap-3">
                <div className="flex -space-x-2">
                    <TokenIcon symbol={token0.symbol} image={image0} size={26} />
                    <TokenIcon symbol={token1.symbol} image={image1} size={26} />
                </div>
                <div className="min-w-0">
                    <div className="truncate text-xs font-medium">
                        {token0.symbol} / {token1.symbol}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1">
                        {/* V2 = cyan (light blue, mirrors stats V2 line).
                            V3 = arc-cta-hover (dark blue, mirrors stats Total). */}
                        <span
                            className={cn(
                                "rounded-md border px-1 py-0.5 text-[9px] uppercase tracking-wider",
                                sub.version === "v2"
                                    ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-400"
                                    : "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover",
                            )}
                        >
                            {sub.version}
                        </span>
                        <span className="rounded-md border border-arc-border bg-arc-bg-elevated px-1 py-0.5 text-[9px] text-arc-text-muted">
                            {feeLabel}
                        </span>
                    </div>
                </div>
            </div>
            <span className="text-right text-xs tabular-nums text-arc-text-faint sm:text-sm">—</span>
            <span className="text-right text-xs tabular-nums text-arc-text-faint sm:text-sm">—</span>
            <span className="text-right text-xs tabular-nums sm:text-sm">{tvlLabel}</span>
            <span className="text-right text-xs tabular-nums text-arc-text-faint sm:text-sm">—</span>
            <Link
                href={`/pool/${sub.address}`}
                className="inline-flex items-center justify-end gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-1.5 text-[11px] font-medium text-arc-text transition-colors hover:bg-white/5"
            >
                Open pool
                <ChevronDown className="h-3 w-3 -rotate-90" />
            </Link>
        </div>
    );
}

// -------------------------------------------------------------------
// Pool pair card (grid / card view)
// -------------------------------------------------------------------

function PoolPairGridCard({ row }: { row: PoolPairRow }) {
    const { image: image0 } = useTokenImage(row.token0.address);
    const { image: image1 } = useTokenImage(row.token1.address);
    const tvlLabel = useMemo(() => formatUsd(row.tvlUsdc), [row.tvlUsdc]);

    // Show up to two badges (one per version+fee variant) like HyperSwap.
    const variantBadges = row.subRows.slice(0, 2);

    return (
        <div className="arc-card flex flex-col gap-3 p-4">
            <div className="flex items-start gap-3">
                <div className="flex -space-x-2">
                    <TokenIcon symbol={row.token0.symbol} image={image0} size={36} />
                    <TokenIcon symbol={row.token1.symbol} image={image1} size={36} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                        {row.token0.symbol} / {row.token1.symbol}
                    </div>
                    {/* Each pool variant gets a version pill AND a separate
                        fee-tier pill (e.g. v3 then 1%), matching the row view
                        and HyperSwap. Cyan = V2, arc-cta-hover navy = V3. */}
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                        {variantBadges.map((v) => (
                            <span
                                key={`${v.address}-${v.version}`}
                                className="flex items-center gap-1"
                            >
                                <span
                                    className={cn(
                                        "rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider",
                                        v.version === "v2"
                                            ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-400"
                                            : "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover",
                                    )}
                                >
                                    {v.version}
                                </span>
                                <span className="rounded-md border border-arc-border bg-arc-bg-elevated px-1.5 py-0.5 text-[9px] text-arc-text-muted">
                                    {v.feeBps / 100}%
                                </span>
                            </span>
                        ))}
                    </div>
                </div>
            </div>

            {row.aprPct !== undefined && row.aprPct > 100 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-md border border-arc-warn/40 bg-arc-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-arc-warn">
                        <Flame className="h-2.5 w-2.5" />
                        Hyped
                    </span>
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                    <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">APR</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-arc-text-faint">—</div>
                </div>
                <div>
                    <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">TVL</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums">{tvlLabel}</div>
                </div>
                <div>
                    <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">
                        1D Volume
                    </div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-arc-text-faint">—</div>
                </div>
                <div>
                    <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">
                        Daily Fees
                    </div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-arc-text-faint">—</div>
                </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
                <Link
                    href={`/positions/add?type=amm&t0=${row.token0.address}&t1=${row.token1.address}`}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-[0.575rem] text-xs font-semibold text-arc-text transition-colors hover:bg-white/5"
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add Liq.
                </Link>
                <Link
                    href="/swap"
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-arc-border bg-sky-400/10 px-3 py-[0.575rem] text-xs font-semibold text-sky-400 transition-colors hover:bg-sky-400/20"
                >
                    <SwapIcon />
                    Swap
                </Link>
            </div>
        </div>
    );
}

// -------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------

function SwapIcon() {
    return <MaskIcon src="/swap.png" size={14} className="bg-sky-400" />;
}

/**
 * Animated SVG linearGradient: a bright stop in the centre slides across the
 * path's bounding box via animateTransform, producing a glint that runs along
 * the line. Each chart line passes a unique id and its base colour, so all
 * three lines can shimmer in their own hue at the same time without colliding.
 */
function ShimmerGradient({ id, color }: { id: string; color: string }) {
    return (
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity={0.55} />
            <stop offset="40%" stopColor={color} stopOpacity={1} />
            <stop offset="50%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="60%" stopColor={color} stopOpacity={1} />
            <stop offset="100%" stopColor={color} stopOpacity={0.55} />
            <animateTransform
                attributeName="gradientTransform"
                type="translate"
                from="-1 0"
                to="1 0"
                dur="3.6s"
                repeatCount="indefinite"
            />
        </linearGradient>
    );
}

/**
 * Renders a PNG as a CSS mask so the icon picks up whatever background
 * colour the caller sets. Lets us swap the lucide icons for /public PNGs
 * (filter, viewligne, viewcard, swap) without losing the white/sky tint
 * we use across the page.
 */
function MaskIcon({
    src,
    size = 16,
    className,
}: {
    src: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            className={cn("inline-block bg-arc-text", className)}
            style={{
                width: size,
                height: size,
                WebkitMaskImage: `url(${src})`,
                maskImage: `url(${src})`,
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
            }}
            aria-hidden
        />
    );
}

/**
 * Compact « ‹ 1 2 3 ... 10 › » pagination strip. Built when the filtered
 * pool list spills past PAGE_SIZE rows. Edge arrows jump to first/last;
 * ellipses fold runs longer than the ±1-around-current window.
 */
function Pagination({
    page,
    pageCount,
    onPage,
}: {
    page: number;
    pageCount: number;
    onPage: (p: number) => void;
}) {
    const pages = useMemo(() => compactPages(page, pageCount), [page, pageCount]);
    const atStart = page === 1;
    const atEnd = page === pageCount;
    return (
        <div className="mt-6 flex items-center justify-center gap-1.5">
            <PageBtn onClick={() => onPage(1)} disabled={atStart} aria-label="First page">
                <ChevronsLeft className="h-3.5 w-3.5" />
            </PageBtn>
            <PageBtn
                onClick={() => onPage(Math.max(1, page - 1))}
                disabled={atStart}
                aria-label="Previous page"
            >
                <ChevronLeft className="h-3.5 w-3.5" />
            </PageBtn>
            {pages.map((p, i) =>
                p === "..." ? (
                    <span
                        key={`gap-${i}`}
                        className="px-1 text-arc-text-muted"
                        aria-hidden
                    >
                        ···
                    </span>
                ) : (
                    <PageBtn
                        key={p}
                        onClick={() => onPage(p)}
                        active={p === page}
                        aria-label={`Page ${p}`}
                        aria-current={p === page ? "page" : undefined}
                    >
                        {p}
                    </PageBtn>
                ),
            )}
            <PageBtn
                onClick={() => onPage(Math.min(pageCount, page + 1))}
                disabled={atEnd}
                aria-label="Next page"
            >
                <ChevronRight className="h-3.5 w-3.5" />
            </PageBtn>
            <PageBtn onClick={() => onPage(pageCount)} disabled={atEnd} aria-label="Last page">
                <ChevronsRight className="h-3.5 w-3.5" />
            </PageBtn>
        </div>
    );
}

function PageBtn({
    onClick,
    disabled,
    active,
    children,
    ...rest
}: {
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    children: React.ReactNode;
} & React.AriaAttributes) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "flex h-9 min-w-[2.25rem] items-center justify-center rounded-lg border px-2 text-xs font-medium backdrop-blur-xl transition-colors",
                active
                    ? "border-arc-cta-hover bg-arc-cta-hover/15 text-arc-text"
                    : "border-arc-border bg-black/15 text-arc-text hover:bg-white/5",
                disabled && "cursor-not-allowed opacity-40 hover:bg-black/15",
            )}
            {...rest}
        >
            {children}
        </button>
    );
}

function compactPages(page: number, total: number): (number | "...")[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const out: (number | "...")[] = [1];
    const start = Math.max(2, page - 1);
    const end = Math.min(total - 1, page + 1);
    if (start > 2) out.push("...");
    for (let i = start; i <= end; i++) out.push(i);
    if (end < total - 1) out.push("...");
    out.push(total);
    return out;
}

function Metric({
    label,
    value,
    pendingIndexer,
}: {
    label: string;
    value: string;
    pendingIndexer?: boolean;
}) {
    return (
        <div className="text-center sm:text-right">
            <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">{label}</div>
            <div
                className={cn(
                    "mt-0.5 text-sm font-semibold tabular-nums",
                    pendingIndexer ? "text-arc-text-faint" : "text-arc-text",
                )}
            >
                {value}
            </div>
        </div>
    );
}

function formatUsd(raw: bigint): string {
    if (raw === 0n) return "—";
    const usd = Number(formatUnits(raw, USDC_DECIMALS));
    if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
    if (usd >= 1_000) return `$${(usd / 1_000).toFixed(2)}k`;
    if (usd < 0.01) return "<$0.01";
    return `$${usd.toFixed(2)}`;
}

function formatBig(n: number): string {
    if (n === 0) return "—";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
    return n.toFixed(2);
}
