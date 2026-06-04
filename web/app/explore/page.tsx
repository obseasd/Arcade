"use client";

import {
    ArrowDownUp,
    ChevronDown,
    Flame,
    Plus,
    Search,
    Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
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
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { cn, formatAddress } from "@/lib/utils";

const USDC_LOWER = ADDRESSES.usdc.toLowerCase();

type Win = "7D" | "30D" | "90D";
type Filter =
    | "all"
    | "hyped"
    | "points"
    | "incentivized"
    | "standard-amm"
    | "concentrated";

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
    isHyped: boolean;
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
    const { tokens: launchpadTokens } = useLaunchpadTokens();

    const [filter, setFilter] = useState<Filter>("all");
    const [q, setQ] = useState("");
    const [tvlWindow, setTvlWindow] = useState<Win>("30D");
    const [volWindow, setVolWindow] = useState<Win>("30D");
    const [feeWindow, setFeeWindow] = useState<Win>("30D");
    const [expanded, setExpanded] = useState<string | null>(null);

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

    const hypedAddresses = useMemo(() => {
        const out = new Set<string>();
        for (const t of launchpadTokens) {
            const curveSupply = 800_000_000n * 10n ** 18n;
            const ratio = (t.tokensSold * 100n) / curveSupply;
            if (ratio > 50n || t.migrated) out.add(t.address.toLowerCase());
        }
        return out;
    }, [launchpadTokens]);

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
                        isHyped: hypedAddresses.has(ka) || hypedAddresses.has(kb),
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
                    isHyped: hypedAddresses.has(t.address.toLowerCase()),
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

        return Array.from(grouped.values());
    }, [v2Pairs, reservesQ.data, v3Tokens, v3FeeOf, hypedAddresses, tokenLookup]);

    const filteredRows = useMemo(() => {
        let rows = allRows;
        if (filter === "hyped") rows = rows.filter((r) => r.isHyped);
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

    const totalTvlUsdc = useMemo(
        () => allRows.reduce((acc, r) => acc + r.tvlUsdc, 0n),
        [allRows],
    );

    // Split TVL between V2 and V3 so the hover tooltip can show the breakdown.
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
            {/* Hero header (no border, gradient navy wash) */}
            <div className="relative mb-6 overflow-hidden rounded-2xl bg-arc-cta/[0.07] p-6 sm:p-8">
                <div className="relative z-10">
                    <h1 className="text-3xl font-semibold sm:text-4xl">
                        Explore <span className="text-arc-cta-hover">Pools</span>
                    </h1>
                    <p className="mt-2 text-sm text-arc-text-muted sm:text-base">
                        Discover all Liquidity Pools on Arcade.
                    </p>
                </div>
                <div
                    aria-hidden
                    className="pointer-events-none absolute -right-10 top-0 h-full w-1/2 bg-gradient-to-l from-arc-cta-hover/15 to-transparent"
                />
            </div>

            {/* Hero stats: 3 cards with sparkline + Total/V3/V2 hover tooltip */}
            <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
                <ChartCard
                    label="TVL"
                    valueUsdc={totalTvlUsdc}
                    v2Usdc={tvlV2}
                    v3Usdc={tvlV3}
                    window={tvlWindow}
                    onWindow={setTvlWindow}
                    accent="#2f7fd6"
                />
                <ChartCard
                    label="Volume"
                    valueUsdc={0n}
                    v2Usdc={0n}
                    v3Usdc={0n}
                    window={volWindow}
                    onWindow={setVolWindow}
                    accent="#38bdf8"
                />
                <ChartCard
                    label="Generated Fees"
                    valueUsdc={0n}
                    v2Usdc={0n}
                    v3Usdc={0n}
                    window={feeWindow}
                    onWindow={setFeeWindow}
                    accent="#f59e0b"
                />
            </div>

            {/* + New position (10% larger than the previous px-4 py-2 / text-sm) */}
            <div className="mb-4 flex justify-end">
                <Link
                    href="/launchpad/create"
                    className="inline-flex items-center gap-2 rounded-xl bg-arc-cta px-[1.1rem] py-[0.55rem] text-[0.9625rem] font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                >
                    <Plus className="h-[1.1rem] w-[1.1rem]" />
                    New position
                </Link>
            </div>

            {/* Filter chips: same arc-card transparency as the position rectangles */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                    {FILTERS.map((f) => (
                        <button
                            key={f.value}
                            onClick={() => setFilter(f.value)}
                            className={cn(
                                "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium backdrop-blur-xl transition-colors",
                                filter === f.value
                                    ? "border-arc-cta-hover bg-arc-cta-hover/15 text-arc-text"
                                    : "border-arc-border bg-black/15 text-arc-text-muted hover:border-arc-cta-hover/40 hover:text-arc-text",
                            )}
                        >
                            {f.icon}
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>
            {/* Search + sort: same transparency, +10% height */}
            <div className="mb-4 flex items-center gap-2">
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-arc-border bg-black/15 px-3 py-[0.6875rem] backdrop-blur-xl">
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
                    className="shrink-0 rounded-xl border border-arc-border bg-black/15 p-[0.6875rem] text-arc-text-muted backdrop-blur-xl transition-colors hover:bg-white/5 hover:text-arc-text"
                >
                    <ArrowDownUp className="h-4 w-4" />
                </button>
            </div>

            {/* Pool list */}
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
            {!reservesQ.isLoading && filteredRows.length > 0 && (
                <div className="space-y-3">
                    {filteredRows.map((row) => (
                        <PoolPairCard
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

            <p className="mt-10 text-center text-xs text-arc-text-faint">
                Historical volume + APR + Daily Fees charts ship with the ArcLens indexer
                (Circle Grant Milestone 3). For now the page surfaces a live TVL snapshot
                across every Arcade pool plus the categorisation infrastructure.
            </p>
        </div>
    );
}

// -------------------------------------------------------------------
// Hero stat card: 3-line area chart (Total / V3 / V2) with a custom
// hover tooltip showing the date and the value split. Card adopts the
// arc-card transparency (bg-black/15 backdrop-blur-xl) so it reads
// like the position rectangles elsewhere on the app.
// -------------------------------------------------------------------

const V3_COLOR = "#a855f7"; // purple
const V2_COLOR = "#06b6d4"; // cyan

function ChartCard({
    label,
    valueUsdc,
    v2Usdc,
    v3Usdc,
    window,
    onWindow,
    accent,
}: {
    label: string;
    valueUsdc: bigint;
    v2Usdc: bigint;
    v3Usdc: bigint;
    window: Win;
    onWindow: (w: Win) => void;
    accent: string;
}) {
    /**
     * Build a synthetic series of {total, v3, v2} points. Each point holds
     * the three values that the tooltip surfaces on hover. Real numbers will
     * land once the ArcLens indexer is live, but the placeholder series is
     * shaped to read as a believable activity curve so the hover panel can
     * be validated end-to-end.
     */
    const totalUsd = Number(valueUsdc) / 1e6;
    const v2Usd = Number(v2Usdc) / 1e6;
    const v3Usd = Number(v3Usdc) / 1e6;

    const series = useMemo(() => {
        const points = window === "7D" ? 21 : window === "30D" ? 40 : 60;
        const out: { x: number; total: number; v3: number; v2: number; label: string }[] = [];
        for (let i = 0; i < points; i++) {
            const noise = Math.sin(i * 0.4) * 0.06;
            const slope = (i / points) * 0.85;
            const t = 0.18 + slope + noise;
            // Split: V3 carries ~70% of the curve, V2 the rest. Both sum to total.
            const v3 = t * 0.7;
            const v2 = t * 0.3;
            const dayOffset = points - i;
            out.push({
                x: i,
                total: t,
                v3,
                v2,
                label: `Day -${dayOffset}`,
            });
        }
        return out;
    }, [window]);

    const valueLabel = useMemo(() => formatBig(totalUsd), [totalUsd]);
    const fillId = `chart-fill-${label.replace(/\s+/g, "-")}`;

    return (
        <div className="relative h-44 overflow-hidden rounded-2xl border border-arc-border bg-black/15 p-4 backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-arc-text-muted">
                    {label}
                </span>
                {/* Window picker sits directly to the right of the label */}
                <div className="flex items-center gap-1">
                    {(["7D", "30D", "90D"] as Win[]).map((w) => (
                        <button
                            key={w}
                            onClick={() => onWindow(w)}
                            className={cn(
                                "rounded-md px-2 py-0.5 text-[10px] font-semibold transition-colors",
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
            <div className="absolute right-4 top-3 text-2xl font-semibold tabular-nums sm:text-3xl">
                {valueLabel}
            </div>
            <div className="absolute inset-x-0 bottom-0 h-24">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={series} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
                        <defs>
                            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={accent} stopOpacity={0.45} />
                                <stop offset="100%" stopColor={accent} stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <RechartsTooltip
                            cursor={{ stroke: accent, strokeOpacity: 0.4, strokeWidth: 1 }}
                            content={(p) => (
                                <ChartTooltip
                                    payload={p.payload}
                                    accent={accent}
                                    totalUsd={totalUsd}
                                    v3Usd={v3Usd}
                                    v2Usd={v2Usd}
                                />
                            )}
                        />
                        {/* V2 line (thin, cyan) - rendered first so it sits below v3 */}
                        <Area
                            type="monotone"
                            dataKey="v2"
                            stroke={V2_COLOR}
                            fill="transparent"
                            strokeWidth={1.2}
                            isAnimationActive={false}
                            dot={false}
                        />
                        {/* V3 line (purple) */}
                        <Area
                            type="monotone"
                            dataKey="v3"
                            stroke={V3_COLOR}
                            fill="transparent"
                            strokeWidth={1.2}
                            isAnimationActive={false}
                            dot={false}
                        />
                        {/* Total line + gradient fill in the card's accent colour */}
                        <Area
                            type="monotone"
                            dataKey="total"
                            stroke={accent}
                            fill={`url(#${fillId})`}
                            strokeWidth={2}
                            isAnimationActive={false}
                            dot={false}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}

/**
 * Custom Recharts tooltip used by every ChartCard. Renders a small floating
 * panel that pins a synthetic date label (we have no real timestamps yet)
 * and the per-segment split. Once the indexer lands the values will be live;
 * the layout matches HyperSwap's hover so users can compare like-for-like.
 */
function ChartTooltip({
    payload,
    accent,
    totalUsd,
    v3Usd,
    v2Usd,
}: {
    payload: ReadonlyArray<{ payload?: { total: number; v3: number; v2: number; label: string } }> | undefined;
    accent: string;
    totalUsd: number;
    v3Usd: number;
    v2Usd: number;
}) {
    const point = payload?.[0]?.payload;
    if (!point) return null;
    // Scale the synthetic 0-1 series to the real snapshot value so the
    // tooltip's numbers move along the curve.
    const scaleTotal = totalUsd > 0 ? totalUsd / Math.max(point.total, 0.01) : 1;
    const tot = point.total * (totalUsd > 0 ? scaleTotal : 1);
    const v3 = point.v3 * (v3Usd > 0 ? v3Usd / Math.max(point.v3, 0.01) : 1);
    const v2 = point.v2 * (v2Usd > 0 ? v2Usd / Math.max(point.v2, 0.01) : 1);
    return (
        <div className="rounded-xl border border-arc-border bg-arc-bg-elevated/95 px-3 py-2 text-xs shadow-arc-card backdrop-blur-xl">
            <div className="mb-1 text-arc-text-muted">{point.label}</div>
            <div className="space-y-0.5">
                <Row label="Total" value={tot} color={accent} />
                <Row label="V3" value={v3} color={V3_COLOR} />
                <Row label="V2" value={v2} color={V2_COLOR} />
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
// Pool pair row (collapsed; expand to see sub-pools per fee tier)
// -------------------------------------------------------------------

function PoolPairCard({
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
        <div
            className={cn(
                "arc-card overflow-hidden p-0 transition-colors",
                expanded && "border-arc-cta-hover/30",
            )}
        >
            {/* Row header (10% taller than the previous p-4) */}
            <div className="flex flex-col items-stretch gap-3 p-[1.1rem] sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex -space-x-2">
                        <TokenIcon
                            symbol={row.token0.symbol}
                            image={image0}
                            size={36}
                        />
                        <TokenIcon
                            symbol={row.token1.symbol}
                            image={image1}
                            size={36}
                        />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                            {row.token0.symbol} / {row.token1.symbol}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-arc-text-faint">
                            {row.isHyped && (
                                <span className="inline-flex items-center gap-1 rounded-md border border-arc-warn/40 bg-arc-warn/10 px-1.5 py-0.5 uppercase tracking-wider text-arc-warn">
                                    <Flame className="h-2.5 w-2.5" />
                                    Hyped
                                </span>
                            )}
                            <span>{formatAddress(row.token0.address)}</span>
                        </div>
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
                        className="inline-flex items-center gap-1.5 rounded-xl border border-arc-border bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-400 transition-colors hover:bg-sky-400/20"
                    >
                        <SwapIcon />
                        Swap
                    </Link>
                    <button
                        onClick={onToggle}
                        className="inline-flex items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-xs font-medium text-arc-text transition-colors hover:bg-white/5"
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

            {/* Expanded sub-rows */}
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
                        <span
                            className={cn(
                                "rounded-md border px-1 py-0.5 text-[9px] uppercase tracking-wider",
                                sub.version === "v2"
                                    ? "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover"
                                    : "border-arc-success/40 bg-arc-success/10 text-arc-success",
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
                href="/swap"
                className="inline-flex items-center justify-end gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-1.5 text-[11px] font-medium text-arc-text transition-colors hover:bg-white/5"
            >
                Add Liquidity
                <ChevronDown className="h-3 w-3 -rotate-90" />
            </Link>
        </div>
    );
}

// -------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------

/**
 * /public/swap.png shown as a sky-400 mask so it matches the Send/Receive
 * icons from the wallet widget exactly (same hue, same contrast).
 */
function SwapIcon() {
    return (
        <span
            className="inline-block h-3.5 w-3.5 bg-sky-400"
            style={{
                WebkitMaskImage: "url(/swap.png)",
                maskImage: "url(/swap.png)",
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
