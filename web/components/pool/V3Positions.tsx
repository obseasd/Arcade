"use client";

import { ArrowLeftRight, ExternalLink, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";

import { V3_FACTORY_ABI, V3_NPM_ABI, V3_POOL_ABI } from "@/lib/abis/v3-npm";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { TokenIcon } from "@/components/ui/TokenIcon";
import {
    getAmountsForLiquidity,
    getSqrtRatioAtTick,
    tickToPriceWithDecimals,
} from "@/lib/v3-math";
import { cn } from "@/lib/utils";

const USDC_LOWER = ADDRESSES.usdc.toLowerCase();

/**
 * Concentrated-liquidity positions owned by the connected wallet. Reads NPM
 * balanceOf -> tokenOfOwnerByIndex(i) -> positions(tokenId) for each NFT,
 * then surfaces a compact row with the pair, fee tier, tick range, and the
 * tokens owed (uncollected fees). Add Liquidity / Collect / Remove flows
 * link to /positions/add and the explorer for now; full manage UI lands
 * with the next iteration.
 */
interface V3RangeFilter {
    inRange: boolean;
    outOfRange: boolean;
    inactive: boolean;
}

export function V3Positions({
    emptyState,
    search = "",
    rangeFilter,
}: {
    emptyState?: React.ReactNode;
    search?: string;
    rangeFilter?: V3RangeFilter;
}) {
    const { address: account } = useAccount();
    const npmEnabled = ADDRESSES.v3PositionManager !== "0x0000000000000000000000000000000000000000";

    const balanceQ = useReadContract({
        address: ADDRESSES.v3PositionManager,
        abi: V3_NPM_ABI,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account && npmEnabled },
    });
    const count = Number((balanceQ.data as bigint | undefined) ?? 0n);

    // Walk tokenOfOwnerByIndex from 0..count-1 to get every token id owned.
    const tokenIdsQ = useReadContracts({
        contracts: account && npmEnabled
            ? Array.from({ length: count }, (_, i) => ({
                  address: ADDRESSES.v3PositionManager,
                  abi: V3_NPM_ABI,
                  functionName: "tokenOfOwnerByIndex" as const,
                  args: [account, BigInt(i)] as const,
              }))
            : [],
        query: { enabled: !!account && npmEnabled && count > 0 },
    });
    const tokenIds = useMemo(
        () =>
            (tokenIdsQ.data ?? [])
                .map((c) => (c.status === "success" ? (c.result as bigint) : undefined))
                .filter((x): x is bigint => x !== undefined),
        [tokenIdsQ.data],
    );

    // For each tokenId, read positions(tokenId) to get the full state.
    const positionsQ = useReadContracts({
        contracts: tokenIds.map((id) => ({
            address: ADDRESSES.v3PositionManager,
            abi: V3_NPM_ABI,
            functionName: "positions" as const,
            args: [id] as const,
        })),
        query: { enabled: tokenIds.length > 0 },
    });

    type RawPosition = readonly [
        bigint,
        Address,
        Address,
        Address,
        number,
        number,
        number,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
    ];
    const positions = useMemo(() => {
        return (positionsQ.data ?? [])
            .map((c, i) => {
                if (c.status !== "success") return undefined;
                const r = c.result as RawPosition;
                return {
                    tokenId: tokenIds[i],
                    token0: r[2],
                    token1: r[3],
                    fee: Number(r[4]),
                    tickLower: Number(r[5]),
                    tickUpper: Number(r[6]),
                    liquidity: r[7],
                    tokensOwed0: r[10],
                    tokensOwed1: r[11],
                };
            })
            .filter((x): x is NonNullable<typeof x> => x !== undefined);
    }, [positionsQ.data, tokenIds]);

    // Gather all unique token addresses for metadata.
    const tokenAddrs = useMemo(() => {
        const s = new Set<string>();
        positions.forEach((p) => {
            s.add(p.token0.toLowerCase());
            s.add(p.token1.toLowerCase());
        });
        return Array.from(s) as Address[];
    }, [positions]);

    const metaQ = useReadContracts({
        contracts: tokenAddrs.flatMap((t) => [
            { address: t, abi: erc20Abi, functionName: "symbol" as const },
            { address: t, abi: erc20Abi, functionName: "decimals" as const },
        ]),
        query: { enabled: tokenAddrs.length > 0 },
    });

    // Resolve the pool address for each position via factory.getPool. The
    // NPM doesn't store the pool address - the canonical Uniswap approach is
    // to derive it via PoolAddress.computeAddress (which we patched server-
    // side, see [[project-arcade-v3-init-hash]]), but on the JS side a
    // factory.getPool round-trip is the simplest match. Parallel to
    // `positions`, indexed by the same i.
    const poolAddrQ = useReadContracts({
        contracts: positions.map((p) => ({
            address: ADDRESSES.v3Factory,
            abi: V3_FACTORY_ABI,
            functionName: "getPool" as const,
            args: [p.token0, p.token1, p.fee] as const,
        })),
        query: { enabled: positions.length > 0 },
    });
    const poolAddrs = useMemo(
        () =>
            (poolAddrQ.data ?? []).map((r) =>
                r.status === "success" ? (r.result as Address) : undefined,
            ),
        [poolAddrQ.data],
    );

    // slot0 for each resolved pool. Needed for underlying-amount computation
    // (getAmountsForLiquidity wants the current sqrtPriceX96) and the
    // in-range badge (current tick vs the position's [tickLower, tickUpper)).
    const slot0Q = useReadContracts({
        contracts: poolAddrs
            .filter((a): a is Address => !!a)
            .map((a) => ({
                address: a,
                abi: V3_POOL_ABI,
                functionName: "slot0" as const,
            })),
        query: { enabled: poolAddrs.some((a) => !!a) },
    });
    // Index slot0 results back by pool address so the per-row lookup is
    // robust against partial query results.
    const slot0ByPool = useMemo(() => {
        const m = new Map<string, { sqrtPriceX96: bigint; tick: number }>();
        const live = poolAddrs.filter((a): a is Address => !!a);
        slot0Q.data?.forEach((res, i) => {
            if (res.status !== "success") return;
            const r = res.result as readonly [bigint, number, ...unknown[]];
            m.set(live[i].toLowerCase(), { sqrtPriceX96: r[0], tick: Number(r[1]) });
        });
        return m;
    }, [slot0Q.data, poolAddrs]);

    const tokenInfo = useMemo(() => {
        const m: Record<string, { symbol: string; decimals: number }> = {};
        if (metaQ.data) {
            tokenAddrs.forEach((addr, i) => {
                m[addr.toLowerCase()] = {
                    symbol:
                        (metaQ.data?.[2 * i]?.result as string | undefined) ??
                        (addr.toLowerCase() === USDC_LOWER ? "USDC" : "TOKEN"),
                    decimals:
                        (metaQ.data?.[2 * i + 1]?.result as number | undefined) ??
                        (addr.toLowerCase() === USDC_LOWER ? USDC_DECIMALS : 18),
                };
            });
        }
        // Always know USDC.
        m[USDC_LOWER] = m[USDC_LOWER] ?? { symbol: "USDC", decimals: USDC_DECIMALS };
        return m;
    }, [metaQ.data, tokenAddrs]);

    if (!npmEnabled) {
        return (
            <div className="arc-card p-8 text-center text-sm text-arc-text-muted">
                The V3 NonfungiblePositionManager has not been wired into this build
                yet. Set NEXT_PUBLIC_V3_NPM_ADDRESS in Vercel to enable Concentrated
                Liquidity here.
            </div>
        );
    }
    if (!account) {
        return (
            emptyState ?? (
                <div className="arc-card p-8 text-center text-sm text-arc-text-muted">
                    Connect a wallet to see your concentrated-liquidity positions.
                </div>
            )
        );
    }
    if (count === 0) {
        return (
            emptyState ?? (
                <div className="arc-card p-8 text-center text-sm text-arc-text-muted">
                    You don&apos;t have any V3 positions yet. Open a new one from
                    {" "}
                    <Link href="/explore" className="text-arc-cta-hover hover:underline">
                        Explore
                    </Link>{" "}
                    or +&nbsp;New&nbsp;position above.
                </div>
            )
        );
    }
    if (positions.length === 0) {
        return (
            <div className="arc-card p-8 text-center text-sm text-arc-text-muted">
                Loading your concentrated positions…
            </div>
        );
    }

    // Filter pipeline: search by token symbol (case-insensitive), then
    // bucket each position via the rangeFilter checkboxes. Default
    // rangeFilter (when the page doesn't pass one) keeps everything on.
    const rf = rangeFilter ?? { inRange: true, outOfRange: true, inactive: true };
    const searchLower = search.trim().toLowerCase();
    const filtered = positions
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => {
            if (!searchLower) return true;
            const s0 = (tokenInfo[p.token0.toLowerCase()]?.symbol ?? "").toLowerCase();
            const s1 = (tokenInfo[p.token1.toLowerCase()]?.symbol ?? "").toLowerCase();
            return s0.includes(searchLower) || s1.includes(searchLower);
        })
        .filter(({ p, i }) => {
            const isInactive = p.liquidity === 0n;
            const slot0 = poolAddrs[i]
                ? slot0ByPool.get(poolAddrs[i]!.toLowerCase())
                : undefined;
            const isInRange =
                !isInactive &&
                !!slot0 &&
                slot0.tick >= p.tickLower &&
                slot0.tick < p.tickUpper;
            const isOutOfRange = !isInactive && !isInRange;
            if (isInactive) return rf.inactive;
            if (isInRange) return rf.inRange;
            if (isOutOfRange) return rf.outOfRange;
            return true;
        });

    if (filtered.length === 0) {
        return (
            <div className="arc-card p-8 text-center text-sm text-arc-text-muted">
                No positions match the current filters.
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {filtered.map(({ p, i }) => (
                <V3PositionRow
                    key={p.tokenId.toString()}
                    position={p}
                    tokenInfo={tokenInfo}
                    poolAddress={poolAddrs[i]}
                    slot0={
                        poolAddrs[i]
                            ? slot0ByPool.get(poolAddrs[i]!.toLowerCase())
                            : undefined
                    }
                />
            ))}
        </div>
    );
}

interface V3PositionRowProps {
    position: {
        tokenId: bigint;
        token0: Address;
        token1: Address;
        fee: number;
        tickLower: number;
        tickUpper: number;
        liquidity: bigint;
        tokensOwed0: bigint;
        tokensOwed1: bigint;
    };
    tokenInfo: Record<string, { symbol: string; decimals: number }>;
    poolAddress: Address | undefined;
    slot0: { sqrtPriceX96: bigint; tick: number } | undefined;
}

function V3PositionRow({
    position: p,
    tokenInfo,
    poolAddress,
    slot0,
}: V3PositionRowProps) {
    const t0Info = tokenInfo[p.token0.toLowerCase()] ?? { symbol: "?", decimals: 18 };
    const t1Info = tokenInfo[p.token1.toLowerCase()] ?? { symbol: "?", decimals: 18 };
    const minPrice = tickToPriceWithDecimals(p.tickLower, t0Info.decimals, t1Info.decimals);
    const maxPrice = tickToPriceWithDecimals(p.tickUpper, t0Info.decimals, t1Info.decimals);
    const explorerUrl = arcTestnet.blockExplorers?.default.url ?? "https://testnet.arcscan.app";

    // Range display is `t1/t0` by default (the canonical V3 tick math). The
    // user can flip it by clicking the pair label so they read the range in
    // whichever side feels native (eg "USDC per ETH" instead of "ETH per
    // USDC"). Inverse swaps numerator/denominator AND symbols, and also
    // flips min<->max because 1/min > 1/max.
    const [inverted, setInverted] = useState(false);
    const displayMin = inverted ? (maxPrice > 0 ? 1 / maxPrice : 0) : minPrice;
    const displayMax = inverted ? (minPrice > 0 ? 1 / minPrice : 0) : maxPrice;
    const numerator = inverted ? t0Info.symbol : t1Info.symbol;
    const denominator = inverted ? t1Info.symbol : t0Info.symbol;

    // Underlying token amounts the position currently represents: derive via
    // LiquidityAmounts.getAmountsForLiquidity using the pool's live sqrtP and
    // the position's tick range. This is the human number the user actually
    // expects to see ("how much of each token is in this position") rather
    // than the raw uint128 L scalar. Falls back to "—" when slot0 is still
    // loading.
    const underlying = (() => {
        if (!slot0 || p.liquidity === 0n) return { amount0: 0n, amount1: 0n };
        try {
            const sqrtA = getSqrtRatioAtTick(p.tickLower);
            const sqrtB = getSqrtRatioAtTick(p.tickUpper);
            return getAmountsForLiquidity(slot0.sqrtPriceX96, sqrtA, sqrtB, p.liquidity);
        } catch {
            return { amount0: 0n, amount1: 0n };
        }
    })();

    const currentPriceRaw = slot0
        ? tickToPriceWithDecimals(slot0.tick, t0Info.decimals, t1Info.decimals)
        : 0;
    const displayCurrent = inverted
        ? currentPriceRaw > 0
            ? 1 / currentPriceRaw
            : 0
        : currentPriceRaw;

    // V3's "in range" check is current tick ∈ [lower, upper). Outside that
    // interval the position is single-sided and earns no fees.
    const inRange =
        !!slot0 && slot0.tick >= p.tickLower && slot0.tick < p.tickUpper;

    return (
        <div className="arc-card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-center gap-3">
                    <div className="flex -space-x-2">
                        <TokenIcon symbol={t0Info.symbol} size={40} />
                        <TokenIcon symbol={t1Info.symbol} size={40} />
                    </div>
                    <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <button
                                onClick={() => setInverted((v) => !v)}
                                title="Invert price units"
                                className="group inline-flex items-center gap-1 text-base font-semibold text-arc-text transition-colors hover:text-arc-cta-hover"
                            >
                                {t0Info.symbol} / {t1Info.symbol}
                                <ArrowLeftRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-70" />
                            </button>
                            <span className="rounded-md border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-arc-cta-hover">
                                v3
                            </span>
                            <span className="rounded-md border border-arc-success/40 bg-arc-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-arc-success">
                                {(p.fee / 10000).toFixed(2)}%
                            </span>
                            <span
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                                    !slot0
                                        ? "bg-arc-bg-elevated text-arc-text-muted"
                                        : inRange
                                          ? "bg-arc-success/15 text-arc-success"
                                          : "bg-arc-warn/15 text-arc-warn",
                                )}
                            >
                                <span
                                    className={cn(
                                        "h-1.5 w-1.5 rounded-full",
                                        !slot0
                                            ? "bg-arc-text-muted"
                                            : inRange
                                              ? "bg-arc-success"
                                              : "bg-arc-warn",
                                    )}
                                />
                                {!slot0 ? "…" : inRange ? "In range" : "Out of range"}
                            </span>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <a
                        href={`${explorerUrl}/token/${ADDRESSES.v3PositionManager}?a=${p.tokenId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-1.5 text-xs font-medium text-arc-text transition-colors hover:bg-white/5"
                    >
                        NFT #{p.tokenId.toString()} <ExternalLink className="h-3 w-3" />
                    </a>
                    {poolAddress && (
                        <Link
                            href={`/pool/${poolAddress}`}
                            className="inline-flex items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-1.5 text-xs font-medium text-arc-text transition-colors hover:bg-white/5"
                        >
                            Open pool
                        </Link>
                    )}
                    <Link
                        href={`/positions/add?type=v3&t0=${p.token0}&t1=${p.token1}&fee=${p.fee / 100}`}
                        className="inline-flex items-center gap-1 rounded-xl border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-3 py-1.5 text-xs font-semibold text-arc-cta-hover transition-colors hover:bg-arc-cta-hover/20"
                    >
                        <Plus className="h-3 w-3" />
                        Add liquidity
                    </Link>
                </div>
            </div>

            {/* Underlying balances - the actual token amounts the user gets if
                they close the position now. Replaces the raw uint128 L scalar
                which carried no human meaning. */}
            <div className="mt-3 rounded-xl border border-arc-border bg-white/[0.015] p-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-arc-text-faint">
                    Your reserve
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="inline-flex items-center gap-2">
                        <TokenIcon symbol={t0Info.symbol} size={20} />
                        <span className="tabular-nums text-arc-text">
                            {formatTok(underlying.amount0, t0Info.decimals)}
                        </span>
                        <span className="text-arc-text-muted">{t0Info.symbol}</span>
                    </div>
                    <div className="inline-flex items-center gap-2">
                        <TokenIcon symbol={t1Info.symbol} size={20} />
                        <span className="tabular-nums text-arc-text">
                            {formatTok(underlying.amount1, t1Info.decimals)}
                        </span>
                        <span className="text-arc-text-muted">{t1Info.symbol}</span>
                    </div>
                </div>
            </div>

            {/* Min / Current / Max price tiles - mirrors the Hyperswap layout
                so the user sees their range relative to the live price at a
                glance. The numerator/denominator labels follow the inverted
                toggle above. */}
            <div className="mt-3 grid grid-cols-3 gap-2">
                <PriceTile
                    label="Min price"
                    value={fmtPrice(displayMin)}
                    unit={`${numerator}/${denominator}`}
                />
                <PriceTile
                    label="Current price"
                    value={fmtPrice(displayCurrent)}
                    unit={`${numerator}/${denominator}`}
                    highlight={inRange}
                />
                <PriceTile
                    label="Max price"
                    value={fmtPrice(displayMax)}
                    unit={`${numerator}/${denominator}`}
                />
            </div>

            {/* Unclaimed fees row. Starts at 0 and ticks up when swaps cross
                the range. Hidden when both legs are zero to keep the card
                quiet on a fresh position. */}
            {(p.tokensOwed0 > 0n || p.tokensOwed1 > 0n) && (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-arc-border bg-white/[0.015] p-3 text-xs">
                    <span className="text-arc-text-muted">Unclaimed fees</span>
                    <span className="inline-flex items-center gap-3 tabular-nums">
                        <span>
                            {formatTok(p.tokensOwed0, t0Info.decimals)}{" "}
                            <span className="text-arc-text-muted">{t0Info.symbol}</span>
                        </span>
                        <span className="text-arc-text-faint">/</span>
                        <span>
                            {formatTok(p.tokensOwed1, t1Info.decimals)}{" "}
                            <span className="text-arc-text-muted">{t1Info.symbol}</span>
                        </span>
                    </span>
                </div>
            )}
        </div>
    );
}

function PriceTile({
    label,
    value,
    unit,
    highlight,
}: {
    label: string;
    value: string;
    unit: string;
    highlight?: boolean;
}) {
    return (
        <div
            className={cn(
                "rounded-xl border bg-white/[0.015] p-3",
                highlight ? "border-arc-success/40" : "border-arc-border",
            )}
        >
            <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">
                {label}
            </div>
            <div className="mt-1 text-base font-semibold tabular-nums text-arc-text">
                {value}
            </div>
            <div className="mt-0.5 text-[10px] text-arc-text-faint">{unit}</div>
        </div>
    );
}

function formatTok(raw: bigint, decimals: number): string {
    if (raw === 0n) return "0";
    const n = Number(formatUnits(raw, decimals));
    if (n < 0.0001) return "<0.0001";
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtPrice(p: number): string {
    if (!isFinite(p) || p === 0) return "0";
    if (p < 0.0001) return p.toExponential(2);
    if (p < 1) return p.toFixed(6);
    return p.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
