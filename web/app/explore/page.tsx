"use client";

import {
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    Flame,
    Info,
    Search,
    Sparkles,
} from "lucide-react";
import {
    DownArrowIcon,
    PlusIcon,
    UpArrowIcon,
} from "@/components/ui/MaskIcon";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { MaskIcon } from "@/components/ui/MaskIcon";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { useV3FactoryPools } from "@/lib/hooks/useV3FactoryPools";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { cn, formatUsd } from "@/lib/utils";

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
        icon: <HotFlameIcon className="h-3.5 w-3.5" />,
    },
    {
        value: "points",
        label: "Points Program",
        icon: (
            <Image
                src="/arcdlogo22.png"
                alt=""
                width={16}
                height={16}
                className="h-4 w-4"
                unoptimized
            />
        ),
    },
    {
        value: "incentivized",
        label: "Incentivized & Liquidity Mining",
        icon: (
            <Image
                src="/pickaxe.svg"
                alt=""
                width={16}
                height={16}
                className="h-4 w-4"
                unoptimized
            />
        ),
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
    /** Token address for V3 sub-rows (used as router param for add liquidity);
     *  pair address for V2 sub-rows. Use `poolAddress` for the actual pool. */
    address: Address;
    /** Concrete on-chain pool/pair address. For V2 it equals `address`; for V3
     *  it's the factory-resolved pool, distinct from the non-USDC token. */
    poolAddress: Address;
    version: "v2" | "v3";
    feeBps: number;
    tvlUsdc: bigint;
}

export default function ExplorePage() {
    const { pairs: v2Pairs, tokens: v2Tokens } = useV2Tokens();
    const { tokens: v3Tokens, feeOf: v3FeeOf, poolOf: v3PoolOf } = useV3Tokens();
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
    // Sort key + direction. APR / Volume are indexer-sourced and undefined
    // for every row right now, so picking those toggles a faint badge on
    // the button but the actual sort falls back to TVL until ArcLens lands.
    const [sortKey, setSortKey] = useState<SortKey>("tvl");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [sortOpen, setSortOpen] = useState(false);
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
        // Curated "incentivized" set surfaces a pulsing LP Boost wrapper on
        // the pair row + sub-rows. Hyperswap-style hand-curated for now;
        // when the indexer ships rule-based incentives this collapses into
        // a real incentivesOf(token0, token1) lookup.
        //
        // Match by EITHER curated address pair (USDC + SeedETH or USDC + WETH
        // if envs are populated) OR by resolved symbol pair (USDC + ETH /
        // USDC + WETH). The symbol fallback is what makes this survive when
        // the env var isn't propagated to the build, when the on-chain "ETH"
        // is actually WETH, or when the address comparison would otherwise
        // come back empty. We apply it as a final post-pass over `grouped`
        // so we only ever evaluate it against resolved row metadata, not
        // mid-construction state. */
        const zero = "0x0000000000000000000000000000000000000000";
        const seedEthLc = ADDRESSES.seedEth.toLowerCase();
        const wethLc = ADDRESSES.weth.toLowerCase();
        const isIncentivisedRow = (row: PoolPairRow): boolean => {
            const a = row.token0.address.toLowerCase();
            const b = row.token1.address.toLowerCase();
            const [lo, hi] = a < b ? [a, b] : [b, a];
            if (lo === USDC_LOWER) {
                if (seedEthLc !== zero && hi === seedEthLc) return true;
                if (wethLc !== zero && hi === wethLc) return true;
            }
            const sa = (row.token0.symbol ?? "").toUpperCase();
            const sb = (row.token1.symbol ?? "").toUpperCase();
            const symbols = sa < sb ? [sa, sb] : [sb, sa];
            if (symbols[0] === "ETH" && symbols[1] === "USDC") return true;
            if (symbols[0] === "USDC" && symbols[1] === "WETH") return true;
            return false;
        };

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
                    poolAddress: v2Pairs[i],
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
            const launchpadPool = v3PoolOf(t.address);
            row.subRows.push({
                address: t.address,
                poolAddress: launchpadPool ?? t.address,
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
                poolAddress: fp.pool,
                version: "v3",
                feeBps: Math.round(fp.feePip / 100),
                tvlUsdc: fp.tvlUsdc,
            });
            row.tvlUsdc += fp.tvlUsdc;
        }

        // Final pass: resolve LP-Boost incentivisation now that every row
        // has its resolved symbols + addresses. This is the single source
        // of truth for `isIncentivized`, replacing the per-call-site
        // address-only checks that didn't survive env / symbol drift.
        const out = Array.from(grouped.values());
        for (const row of out) {
            row.isIncentivized = isIncentivisedRow(row);
        }
        return out;
    }, [v2Pairs, reservesQ.data, v3Tokens, v3FeeOf, v3PoolOf, v3FactoryPools, tokenLookup]);

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
        return rows.slice().sort((a, b) => {
            // Pick the per-row metric. APR is undefined for every row until
            // the indexer ships, and Volume isn't surfaced yet, so both fall
            // back to TVL so the click doesn't produce an apparent no-op.
            const av = sortKey === "apr" ? (a.aprPct ?? -1) : Number(a.tvlUsdc);
            const bv = sortKey === "apr" ? (b.aprPct ?? -1) : Number(b.tvlUsdc);
            const cmp = av === bv ? 0 : av > bv ? 1 : -1;
            return sortDir === "desc" ? -cmp : cmp;
        });
    }, [allRows, filter, q, sortKey, sortDir]);

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
                <button type="button"
                    onClick={() => setCreateOpen(true)}
                    className="inline-flex items-center gap-2 rounded-xl bg-arc-cta px-[1.1rem] py-[0.55rem] text-[0.9625rem] font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                >
                    <PlusIcon size={18} className="bg-white" />
                    New position
                </button>
            </div>

            {/* Filter chips - Hyperswap-style: white text on dark glass, the
                selected chip gets a brighter white-tinted background to read as
                "on" without a coloured border ring. Icons stay tinted (orange
                Flame, sky Sparkles, etc) so the row still reads visually. */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-1.5">
                    {FILTERS.map((f) => (
                        <button type="button"
                            key={f.value}
                            onClick={() => setFilter(f.value)}
                            className={cn(
                                "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium backdrop-blur-xl transition-all",
                                filter === f.value
                                    ? "border-white/30 bg-white/15 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]"
                                    : "border-white/10 bg-white/[0.04] text-arc-text hover:border-white/20 hover:bg-white/[0.08]",
                            )}
                        >
                            {f.icon}
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Incentivized filter CTA banner. Mirrors HyperSwap's
                "Start a campaign" pattern: when the user filters to
                incentivized pools we surface the creation flow inline so
                the orphan /swap/incentivize route is reachable. */}
            {filter === "incentivized" && (
                <div className="mb-4 flex items-center gap-2 text-xs text-arc-text">
                    <Info className="h-3.5 w-3.5 shrink-0 text-arc-text-muted" />
                    <span className="text-arc-text-muted">
                        Want to boost your pool's visibility? Create an incentive
                        campaign to attract liquidity providers and increase
                        trading volume.{" "}
                    </span>
                    <Link
                        href="/swap/incentivize"
                        className="font-semibold text-white underline underline-offset-2 hover:text-arc-cta-hover focus:outline-none focus:ring-2 focus:ring-arc-cta-hover focus:ring-offset-2 focus:ring-offset-arc-bg"
                    >
                        Start a campaign
                    </Link>
                </div>
            )}
            {/* Search + sort + view-mode toggle. Both icon buttons are perfect
                squares (h-11 w-11), and the search bar matches that height so
                the row reads as a uniform 44-px control strip. */}
            <div className="mb-4 flex items-center gap-2">
                <div className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-arc-border bg-black/15 px-3 backdrop-blur-xl">
                    <Search className="h-4 w-4 text-arc-text-faint" />
                    <input
                        aria-label="Search tokens"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search by token name..."
                        className="arc-input w-full bg-transparent text-sm"
                    />
                </div>
                <SortDropdown
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
                <button type="button"
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
                    {/* One card per (pair, version+fee) combo - V2 and V3
                        variants stand apart. flatMap preserves the pair's
                        row order before splitting on sub-rows. */}
                    {pageRows.flatMap((row) =>
                        row.subRows.map((sub) => (
                            <PoolPairGridCard
                                key={`${row.key}-${sub.poolAddress}`}
                                row={row}
                                sub={sub}
                                whiteCta={filter !== "all"}
                            />
                        )),
                    )}
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
                        <button type="button"
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
                <div className="absolute -top-2.5 left-4 z-10 inline-flex items-center gap-1 rounded-md border border-arc-primary-hover bg-arc-bg-elevated px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-300">
                    <Sparkles className="h-2.5 w-2.5" />
                    LP Boost
                </div>
            )}
            <div
                className={cn(
                    "arc-card overflow-hidden p-0 transition-colors",
                    expanded && "border-arc-cta-hover/30",
                    // Incentivized: animate-lp-boost (defined in globals.css)
                    // applies a blue 2px rim with a conic-gradient highlight
                    // that orbits the perimeter like a fluid through a pipe.
                    // Border-color override + outer glow live in the same
                    // class, so we don't pre-apply a border colour here that
                    // the animation would have to fight.
                    row.isIncentivized && "animate-lp-boost",
                )}
            >
            {/* Row header. p-[1.331rem] is 1.21rem * 1.1 = +10% height vs the
                prior spec (already +10% over the original 1.1rem). Metrics
                column gets text-center so the values line up under their
                column headers regardless of pair-name length. */}
            {/* Row header. 3-column CSS grid: tokens block (pinned width on
                sm+ so the metrics align consistently across rows), metrics
                block (1fr, centered), actions block (auto, pinned so the
                Show/Hide toggle width change doesn't shift Swap). Mirrors
                Hyperswap's pair-row spec. */}
            <div className="flex flex-col items-stretch gap-3 p-[1.331rem] sm:grid sm:grid-cols-[16rem_1fr_14.5rem] sm:items-center sm:gap-4">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex -space-x-4">
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
                        <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">
                                {row.token0.symbol} / {row.token1.symbol}
                            </span>
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
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Metric label="Best APR" value="—" pendingIndexer center />
                    <Metric label="Daily Fees" value="—" pendingIndexer center />
                    <Metric label="TVL" value={tvlLabel} center />
                    <Metric label="1D Volume" value="—" pendingIndexer center />
                </div>
                <div className="flex items-center justify-end gap-2">
                    <Link
                        href="/swap"
                        className="inline-flex items-center gap-1.5 rounded-xl bg-arc-cta px-3 py-[0.575rem] text-xs font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                    >
                        <SwapIcon tone="white" />
                        Swap
                    </Link>
                    <button type="button"
                        onClick={onToggle}
                        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-xl border border-arc-border bg-white/[0.04] px-3 py-[0.575rem] text-xs font-medium text-arc-text transition-colors hover:bg-white/[0.08]"
                    >
                        {expanded ? "Hide pools" : `Show all pools (${subCount})`}
                        {expanded ? <UpArrowIcon size={14} /> : <DownArrowIcon size={14} />}
                    </button>
                </div>
            </div>

            {expanded && (
                <div className="border-t border-arc-border bg-white/[0.015]">
                    {/* Sub-row header pill - dark background lifts the column
                        labels off the row background so they read as a header
                        strip (Hyperswap pattern). 3-column grid matches the
                        outer row spec so column centers line up exactly. */}
                    <div className="hidden grid-cols-[16rem_1fr_14.5rem] gap-4 bg-arc-bg-elevated/60 px-4 py-2.5 text-[10px] uppercase tracking-wider text-arc-text-muted sm:grid">
                        <span className="text-sm font-semibold text-arc-text">
                            Pools ({subCount})
                        </span>
                        <div className="grid grid-cols-4 gap-2">
                            <span className="text-center">APR</span>
                            <span className="text-center">Daily Fees</span>
                            <span className="text-center">TVL</span>
                            <span className="text-center">1D Volume</span>
                        </div>
                        <span />
                    </div>
                    {row.subRows.map((sub) => {
                        // "Best" chips per metric. APR / Volume fall back to
                        // undefined (no indexer) so only TVL renders for now;
                        // the labels match the Hyperswap pattern visually.
                        const bestTvl = row.subRows.reduce(
                            (max, s) => (s.tvlUsdc > max ? s.tvlUsdc : max),
                            0n,
                        );
                        const isBestTvl = sub.tvlUsdc === bestTvl && bestTvl > 0n;
                        return (
                            <PoolSubRowCard
                                key={`${sub.address}-${sub.version}`}
                                sub={sub}
                                token0={row.token0}
                                token1={row.token1}
                                image0={image0}
                                image1={image1}
                                isBestTvl={isBestTvl}
                                isIncentivized={row.isIncentivized}
                            />
                        );
                    })}
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
    isBestTvl,
    isIncentivized,
}: {
    sub: PoolSubRow;
    token0: { address: Address; symbol: string };
    token1: { address: Address; symbol: string };
    image0?: string;
    image1?: string;
    /** True when this sub-row holds the largest TVL across the pair's
     *  other sub-rows. Surfaces a small "Best TVL" chip below the
     *  version/fee row, mirroring Hyperswap's superlative labels. */
    isBestTvl?: boolean;
    /** True when the parent row is in the curated incentivized set
     *  (USDC/ETH, USDC/WETH, etc). Surfaces an animated rainbow
     *  "Incentivized" pill among the version/fee/TVL chips. */
    isIncentivized?: boolean;
}) {
    const feeLabel = `${sub.feeBps / 100}%`;
    const tvlLabel = formatUsd(sub.tvlUsdc);
    // The "paired" token is the non-USDC side of the pair; that's the
    // contract the user actually wants to grab for explorer / share /
    // trading-bot input. Falls back to token1 if neither side is USDC.
    const pairedAddress =
        token0.address.toLowerCase() === ADDRESSES.usdc.toLowerCase()
            ? token1.address
            : token0.address;
    // Skip the prior /pool/<address> transitional page - the sub-row CTA
    // now jumps straight into /positions/add with the pair (+ fee tier for
    // V3) pre-filled. Same query shape as PoolPairGridCard so both views
    // land on the identical Add Liquidity form.
    const addLiqHref =
        sub.version === "v3"
            ? `/positions/add?type=v3&t0=${token0.address}&t1=${token1.address}&fee=${sub.feeBps}`
            : `/positions/add?type=amm&t0=${token0.address}&t1=${token1.address}`;
    return (
        <div className="grid grid-cols-1 items-center gap-3 px-4 py-3 sm:grid-cols-[16rem_1fr_14.5rem] sm:gap-4">
            <div className="flex items-center gap-3">
                <div className="flex -space-x-3">
                    <TokenIcon symbol={token0.symbol} image={image0} size={26} />
                    <TokenIcon symbol={token1.symbol} image={image1} size={26} />
                </div>
                <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium">
                            {token0.symbol} / {token1.symbol}
                        </span>
                        {isBestTvl && (
                            <CopyAddressButton address={pairedAddress} />
                        )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span
                            className={cn(
                                "rounded-md px-1.5 py-0.5 text-[12px] tracking-wider",
                                sub.version === "v2"
                                    ? "bg-arc-cta text-white"
                                    : "bg-sky-400 text-black",
                            )}
                        >
                            {sub.version}
                        </span>
                        <span className="rounded-md bg-[#171718] px-1.5 py-0.5 text-[12px] text-sky-400">
                            {feeLabel}
                        </span>
                        {isBestTvl && (
                            <span className="rounded-md bg-purple-400/10 px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wider text-purple-300">
                                Best TVL
                            </span>
                        )}
                        {isIncentivized && sub.version === "v3" && (
                            <>
                                <span className="inc-badge inc-badge-sm inc-sweep-5 rounded-md px-1.5 py-0.5 text-[12px] tracking-wider">
                                    Incentivized
                                    <Info className="inc-info" />
                                </span>
                                <span className="inc-badge hot-apr-rim rounded-md px-1.5 py-0.5 text-[12px] tracking-wider">
                                    <HotFlameIcon className="h-3.5 w-3.5" />
                                    Hot APR
                                </span>
                            </>
                        )}
                    </div>
                </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs sm:text-sm">
                <span className="text-center tabular-nums text-arc-text-faint">—</span>
                <span className="text-center tabular-nums text-arc-text-faint">—</span>
                <span className="text-center tabular-nums">{tvlLabel}</span>
                <span className="text-center tabular-nums text-arc-text-faint">—</span>
            </div>
            <div className="flex justify-end">
                <Link
                    href={addLiqHref}
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-xl bg-arc-cta px-3 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                >
                    <PlusIcon size={12} className="bg-white" />
                    Add Liquidity
                </Link>
            </div>
        </div>
    );
}

// -------------------------------------------------------------------
// Pool pair card (grid / card view)
// -------------------------------------------------------------------

/**
 * Single-version card for the grid view. The row-view (PoolPairRowCard)
 * shows the pair once with sub-rows below it; here we flat-map into one
 * card per (pair, version) so the V2 and V3 variants stand alone and
 * size proportionally. Add Liq routes to the right type (amm vs v3).
 * No "Best APR/Volume/TVL" chips - those only fit on the list view
 * because each card is already isolated. */
function PoolPairGridCard({
    row,
    sub,
    whiteCta = false,
}: {
    row: PoolPairRow;
    sub: PoolSubRow;
    /** When the user filters the grid to anything other than "All" (Hyped,
     *  Points, Incentivized, Standard AMM, Concentrated), the action
     *  buttons shift to the same white/glass palette as the selected
     *  filter chip. Visually anchors "you filtered this in" so the card
     *  CTAs read in the same language as the filter row above. */
    whiteCta?: boolean;
}) {
    const { image: image0 } = useTokenImage(row.token0.address);
    const { image: image1 } = useTokenImage(row.token1.address);
    const tvlLabel = useMemo(() => formatUsd(sub.tvlUsdc), [sub.tvlUsdc]);
    const isV3 = sub.version === "v3";
    const addLiqHref = isV3
        ? `/positions/add?type=v3&t0=${row.token0.address}&t1=${row.token1.address}&fee=${sub.feeBps}`
        : `/positions/add?type=amm&t0=${row.token0.address}&t1=${row.token1.address}`;

    return (
        // +10% padding vs the old grid card (p-4 -> p-[1.1rem]) so the
        // card has more breathing room and matches the list row's bumped
        // height.
        <div className="arc-card flex flex-col gap-3 p-[1.1rem]">
            <div className="flex items-start gap-3">
                <div className="flex -space-x-3">
                    <TokenIcon symbol={row.token0.symbol} image={image0} size={40} />
                    <TokenIcon symbol={row.token1.symbol} image={image1} size={40} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">
                            {row.token0.symbol} / {row.token1.symbol}
                        </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                            className={cn(
                                "rounded-md px-1.5 py-0.5 text-[12px] tracking-wider",
                                isV3
                                    ? "bg-sky-400 text-black"
                                    : "bg-arc-cta text-white",
                            )}
                        >
                            {sub.version}
                        </span>
                        <span className="rounded-md bg-[#171718] px-1.5 py-0.5 text-[12px] text-sky-400">
                            {sub.feeBps / 100}%
                        </span>
                    </div>
                </div>
            </div>

            {row.isIncentivized && isV3 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inc-badge inc-badge-sm inc-sweep-5 rounded-md px-1.5 py-0.5 text-[12px] tracking-wider">
                        Incentivized
                        <Info className="inc-info" />
                    </span>
                    <span className="inc-badge hot-apr-rim rounded-md px-1.5 py-0.5 text-[12px] tracking-wider">
                        <HotFlameIcon className="h-3.5 w-3.5" />
                        Hot APR
                    </span>
                </div>
            )}

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
                    href={addLiqHref}
                    className={cn(
                        "inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-[0.575rem] text-xs font-semibold transition-colors",
                        whiteCta
                            ? "border border-white/25 bg-white/15 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-white/20"
                            : "bg-arc-cta text-white hover:bg-arc-cta-hover",
                    )}
                >
                    <PlusIcon size={14} className="bg-white" />
                    Add Liquidity
                </Link>
                <Link
                    href="/swap"
                    className={cn(
                        "inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-[0.575rem] text-xs font-semibold text-white transition-colors",
                        whiteCta
                            ? "border border-white/15 bg-white/[0.06] hover:bg-white/[0.12]"
                            : "bg-arc-cta hover:bg-arc-cta-hover",
                    )}
                >
                    <SwapIcon tone="white" />
                    Swap
                </Link>
            </div>
        </div>
    );
}

// -------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------

function SwapIcon({ tone = "sky" }: { tone?: "sky" | "white" }) {
    return (
        <MaskIcon
            src="/swap.png"
            size={14}
            className={tone === "white" ? "bg-white" : "bg-sky-400"}
        />
    );
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

// MaskIcon moved to @/components/ui/MaskIcon for reuse on /positions.

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
        <button type="button"
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
    center,
}: {
    label: string;
    value: string;
    pendingIndexer?: boolean;
    /** Center the label + value horizontally instead of right-aligning. The
     *  pair row header reads more naturally with centered columns when the
     *  header label widths differ ("Best APR" vs "1D Volume"). */
    center?: boolean;
}) {
    return (
        <div className={cn("text-center", !center && "sm:text-right")}>
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

/**
 * Custom Minecraft-style pickaxe icon. Built from two stacked paths
 * (cyan diamond head + brown wooden handle) so it reads as the
 * blocky game item at chip sizes. Replaces the rocket emoji on the
 * "Incentivized & Liquidity Mining" filter chip; "mining" → pickaxe
 * is the more direct semantic link.
 *
 * Stroke colours are darker shades of the fill (Minecraft-style
 * cell-shading outline) so the silhouette stays crisp at 14px.
 */
function MinecraftPickaxeIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            className={className}
            aria-hidden="true"
        >
            {/* Wooden handle (brown stick from head down to bottom-left) */}
            <path
                d="M12.2 10.6 L3 19.8 L4.2 21 L13.4 11.8 Z"
                fill="#7C2D12"
                stroke="#3D1B0E"
                strokeWidth="0.7"
                strokeLinejoin="round"
            />
            {/* Diamond pickaxe head: two-prong V shape with a flat socket */}
            <path
                d="M3 5 L7.5 3.5 L12 8 L16.5 3.5 L21 5 L20 8.5 L16 11.5 L12 8 L8 11.5 L4 8.5 Z"
                fill="#38BDF8"
                stroke="#075985"
                strokeWidth="0.7"
                strokeLinejoin="round"
            />
            {/* Lighter highlight on the upper edge of the head (diamond shine) */}
            <path
                d="M7 5 L12 8.5 L17 5"
                fill="none"
                stroke="#BAE6FD"
                strokeWidth="0.7"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/**
 * Custom flame icon styled to read like a colour emoji 🔥. Uses the
 * tabler-icons flame path (more curved / stylised than Lucide's) with
 * a warm orange fill, a red-orange stroke (rounded joins so the silhouette
 * stays "soft" at small sizes), and an inner core gradient that brightens
 * the upper third the way an emoji flame's hot spot does.
 *
 * The path + colour pair (#ec9f48 fill / #e9421e stroke) was supplied by
 * the user as the reference look — the gradient core is layered on top
 * to keep the multi-stop emoji feel of the prior implementation.
 *
 * Gradient IDs are fixed; SVG defs are shared per-document so even when
 * the page mounts the icon twice (row view + grid view both rendered),
 * both instances reference the same gradient definitions safely.
 */
function HotFlameIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#e9421e"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <defs>
                <linearGradient id="arc-hot-flame-core" x1="0" y1="1" x2="0" y2="0">
                    <stop offset="0%" stopColor="#ec9f48" />
                    <stop offset="55%" stopColor="#fcd34d" />
                    <stop offset="100%" stopColor="#fef9c3" />
                </linearGradient>
            </defs>
            <path
                d="M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.621 -2.333 5.588c0 3.704 3.134 6.706 7 6.706s7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235"
                fill="#ec9f48"
            />
            <path
                d="M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.621 -2.333 5.588c0 3.704 3.134 6.706 7 6.706s7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235"
                fill="url(#arc-hot-flame-core)"
                fillOpacity="0.65"
                stroke="none"
            />
        </svg>
    );
}

/**
 * Compact copy-to-clipboard button. Used next to pair labels in /explore
 * and /positions so the user can grab the token contract without hunting
 * through the explorer. Flashes a check for 1s after a successful copy.
 */
function CopyAddressButton({ address }: { address: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button type="button"
            onClick={async (e) => {
                e.stopPropagation();
                e.preventDefault();
                try {
                    await navigator.clipboard.writeText(address);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1000);
                } catch {
                    /* ignore - older browsers without clipboard API */
                }
            }}
            title={copied ? "Copied!" : `Copy ${address.slice(0, 6)}…${address.slice(-4)}`}
            className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-arc-border bg-arc-bg-elevated text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
        >
            {copied ? (
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-2.5 w-2.5"
                >
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            ) : (
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-2.5 w-2.5"
                >
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
            )}
        </button>
    );
}

// formatUsd lives in @/lib/utils now.

function formatBig(n: number): string {
    if (n === 0) return "—";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
    return n.toFixed(2);
}

type SortKey = "tvl" | "apr" | "volume";
type SortDir = "asc" | "desc";

const SORT_LABEL: Record<SortKey, string> = {
    tvl: "TVL",
    apr: "APR",
    volume: "Volume",
};

interface SortDropdownProps {
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
    sortKey: SortKey;
    sortDir: SortDir;
    onPick: (k: SortKey, d: SortDir) => void;
}

/**
 * Sort menu on Explore. Click the icon to open; each row toggles the
 * direction when its key is already selected (single tap to cycle
 * asc/desc instead of needing a separate direction button). Mirrors
 * Hyperswap's compact pattern.
 */
function SortDropdown({
    open,
    onToggle,
    onClose,
    sortKey,
    sortDir,
    onPick,
}: SortDropdownProps) {
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
            <button type="button"
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
                    {(["tvl", "apr", "volume"] as SortKey[]).map((k) => {
                        const isActive = k === sortKey;
                        return (
                            <button type="button"
                                key={k}
                                onClick={() => {
                                    // Same key clicked → flip direction; new
                                    // key → default to desc (highest first,
                                    // matches the user mental model for TVL/
                                    // Volume).
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
                                <span>{SORT_LABEL[k]}</span>
                                {isActive &&
                                    (sortDir === "desc" ? (
                                        <DownArrowIcon size={14} />
                                    ) : (
                                        <UpArrowIcon size={14} />
                                    ))}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
