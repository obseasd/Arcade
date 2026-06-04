"use client";

import { ArrowLeft, ExternalLink, Plus, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { Address, erc20Abi, formatUnits, isAddress, zeroAddress } from "viem";
import { useAccount, useReadContract } from "wagmi";

import { PAIR_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { cn, formatAddress } from "@/lib/utils";

const USDC_LOWER = ADDRESSES.usdc.toLowerCase();

/**
 * Generic V2 pair detail page. Reads the pair contract directly so any address
 * routed here (eg from the post-add toast or a deep link) renders even before
 * the indexer has caught the new pair.
 *
 * V3 detail rendering is queued for the ArcLens ship - the page will detect a
 * V3 pool via slot0() and switch to a Concentrated layout. For now V3-only
 * addresses fall through to the "data not yet indexed" empty state.
 */
export default function PoolDetailPage() {
    const params = useParams<{ address: string }>();
    const { address: account } = useAccount();
    const pairAddrRaw = params?.address ?? "";
    const pair = isAddress(pairAddrRaw)
        ? (pairAddrRaw as Address)
        : (zeroAddress as Address);
    const isPair = pair !== zeroAddress;

    const token0Q = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "token0",
        query: { enabled: isPair },
    });
    const token1Q = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "token1",
        query: { enabled: isPair },
    });
    const reservesQ = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "getReserves",
        query: { enabled: isPair },
    });
    const totalSupplyQ = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "totalSupply",
        query: { enabled: isPair },
    });
    const lpBalanceQ = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: isPair && !!account },
    });

    const token0 = token0Q.data as Address | undefined;
    const token1 = token1Q.data as Address | undefined;

    const token0Meta = useTokenMeta(token0);
    const token1Meta = useTokenMeta(token1);

    const { tvlUsdc, reserve0, reserve1, ratio01, ratio10, poolSharePct } = useMemo(() => {
        if (!reservesQ.data || !token0 || !token1) {
            return {
                tvlUsdc: 0n,
                reserve0: 0n,
                reserve1: 0n,
                ratio01: undefined as string | undefined,
                ratio10: undefined as string | undefined,
                poolSharePct: undefined as string | undefined,
            };
        }
        const [r0, r1] = reservesQ.data as [bigint, bigint, number];
        let tvl = 0n;
        if (token0.toLowerCase() === USDC_LOWER) tvl = r0 * 2n;
        else if (token1.toLowerCase() === USDC_LOWER) tvl = r1 * 2n;

        const r0Num = Number(formatUnits(r0, token0Meta?.decimals ?? 18));
        const r1Num = Number(formatUnits(r1, token1Meta?.decimals ?? 18));

        const totalSupply = totalSupplyQ.data as bigint | undefined;
        const lpBal = lpBalanceQ.data as bigint | undefined;
        let share: string | undefined = undefined;
        if (totalSupply && totalSupply > 0n && lpBal !== undefined) {
            const pct = (Number(lpBal) / Number(totalSupply)) * 100;
            share = `${pct.toFixed(4)}%`;
        }

        return {
            tvlUsdc: tvl,
            reserve0: r0,
            reserve1: r1,
            ratio01: r0Num > 0 ? (r1Num / r0Num).toLocaleString(undefined, { maximumFractionDigits: 6 }) : undefined,
            ratio10: r1Num > 0 ? (r0Num / r1Num).toLocaleString(undefined, { maximumFractionDigits: 6 }) : undefined,
            poolSharePct: share,
        };
    }, [reservesQ.data, token0, token1, token0Meta?.decimals, token1Meta?.decimals, totalSupplyQ.data, lpBalanceQ.data]);

    const explorerUrl =
        arcTestnet.blockExplorers?.default.url ?? "https://testnet.arcscan.app";

    if (!isPair) {
        return (
            <div className="mx-auto max-w-3xl px-4 py-10 text-center">
                <div className="arc-card p-12 text-sm text-arc-text-muted">
                    {pairAddrRaw
                        ? `${pairAddrRaw} is not a valid address.`
                        : "No pool address in the URL."}
                </div>
            </div>
        );
    }

    const sym0 = token0Meta?.symbol ?? "?";
    const sym1 = token1Meta?.symbol ?? "?";
    const addLiqHref = token0 && token1
        ? `/positions/add?type=amm&t0=${token0}&t1=${token1}`
        : "/positions/add";

    return (
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
            <Link
                href="/explore"
                className="mb-3 inline-flex items-center gap-1.5 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" />
                Back to Explore
            </Link>

            {/* Header */}
            <div className="arc-card mb-4 flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                    <div className="flex -space-x-2">
                        <TokenIcon symbol={sym0} size={44} />
                        <TokenIcon symbol={sym1} size={44} />
                    </div>
                    <div>
                        <div className="text-xl font-semibold">
                            {sym0} / {sym1}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                            <span className="rounded-md border border-cyan-400/40 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-cyan-400">
                                v2
                            </span>
                            <span className="rounded-md border border-arc-success/40 bg-arc-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-arc-success">
                                0.30%
                            </span>
                            <a
                                href={`${explorerUrl}/address/${pair}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[10px] text-arc-text-muted hover:text-arc-cta-hover"
                            >
                                {formatAddress(pair)}
                                <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Link
                        href={addLiqHref}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-arc-cta px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                    >
                        <Plus className="h-4 w-4" />
                        Add Liquidity
                    </Link>
                    <Link
                        href="/swap"
                        className="inline-flex items-center gap-1.5 rounded-xl border border-arc-border bg-sky-400/10 px-4 py-2 text-sm font-semibold text-sky-400 transition-colors hover:bg-sky-400/20"
                    >
                        <TrendingUp className="h-4 w-4" />
                        Swap
                    </Link>
                </div>
            </div>

            {/* KPI strip */}
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Kpi label="TVL" value={tvlUsdc > 0n ? formatUsd(tvlUsdc) : "—"} />
                <Kpi label="24h Volume" value="—" pendingIndexer />
                <Kpi label="24h Fees" value="—" pendingIndexer />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
                {/* Chart placeholder + activity */}
                <div className="arc-card flex h-64 items-center justify-center p-6 text-sm text-arc-text-muted lg:h-auto">
                    Pool price chart ships with ArcLens.
                </div>

                {/* Composition + your position */}
                <div className="space-y-3">
                    <div className="arc-card p-4">
                        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-arc-text-muted">
                            Pool composition
                        </div>
                        <div className="space-y-2 text-sm">
                            <Row
                                left={
                                    <span className="inline-flex items-center gap-2">
                                        <TokenIcon symbol={sym0} size={20} />
                                        {sym0}
                                    </span>
                                }
                                right={
                                    <span className="tabular-nums">
                                        {formatAmount(reserve0, token0Meta?.decimals ?? 18)}
                                    </span>
                                }
                            />
                            <Row
                                left={
                                    <span className="inline-flex items-center gap-2">
                                        <TokenIcon symbol={sym1} size={20} />
                                        {sym1}
                                    </span>
                                }
                                right={
                                    <span className="tabular-nums">
                                        {formatAmount(reserve1, token1Meta?.decimals ?? 18)}
                                    </span>
                                }
                            />
                            <div className="border-t border-arc-border" />
                            <Row
                                left={<span className="text-arc-text-muted">{sym1} per {sym0}</span>}
                                right={<span className="tabular-nums">{ratio01 ?? "—"}</span>}
                            />
                            <Row
                                left={<span className="text-arc-text-muted">{sym0} per {sym1}</span>}
                                right={<span className="tabular-nums">{ratio10 ?? "—"}</span>}
                            />
                        </div>
                    </div>

                    {account ? (
                        <div className="arc-card p-4">
                            <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-arc-text-muted">
                                Your position
                            </div>
                            <Row
                                left={<span className="text-sm">LP balance</span>}
                                right={
                                    <span className="text-sm font-semibold tabular-nums">
                                        {formatAmount(
                                            (lpBalanceQ.data as bigint | undefined) ?? 0n,
                                            18,
                                        )}
                                    </span>
                                }
                            />
                            <Row
                                left={<span className="text-sm">Share of pool</span>}
                                right={
                                    <span className="text-sm font-semibold tabular-nums">
                                        {poolSharePct ?? "0%"}
                                    </span>
                                }
                            />
                        </div>
                    ) : (
                        <div className="arc-card p-4 text-sm text-arc-text-muted">
                            Connect a wallet to see your LP balance + share.
                        </div>
                    )}
                </div>
            </div>

            <p className="mt-8 text-center text-xs text-arc-text-faint">
                Activity feed + price history ship with the ArcLens indexer (Circle Grant
                Milestone 3).
            </p>
        </div>
    );
}

function useTokenMeta(addr: Address | undefined) {
    const symQ = useReadContract({
        address: addr,
        abi: erc20Abi,
        functionName: "symbol",
        query: { enabled: !!addr },
    });
    const decQ = useReadContract({
        address: addr,
        abi: erc20Abi,
        functionName: "decimals",
        query: { enabled: !!addr },
    });
    if (!addr) return undefined;
    if (addr.toLowerCase() === USDC_LOWER) {
        return { symbol: "USDC", decimals: USDC_DECIMALS };
    }
    return {
        symbol: (symQ.data as string | undefined) ?? "TOKEN",
        decimals: (decQ.data as number | undefined) ?? 18,
    };
}

function Kpi({
    label,
    value,
    pendingIndexer,
}: {
    label: string;
    value: string;
    pendingIndexer?: boolean;
}) {
    return (
        <div className="arc-card p-4">
            <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">
                {label}
            </div>
            <div
                className={cn(
                    "mt-1 text-2xl font-semibold tabular-nums",
                    pendingIndexer ? "text-arc-text-faint" : "text-arc-text",
                )}
            >
                {value}
            </div>
        </div>
    );
}

function Row({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between">
            {left}
            {right}
        </div>
    );
}

function formatUsd(raw: bigint): string {
    const usd = Number(formatUnits(raw, USDC_DECIMALS));
    if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
    if (usd >= 1_000) return `$${(usd / 1_000).toFixed(2)}k`;
    if (usd < 0.01) return "<$0.01";
    return `$${usd.toFixed(2)}`;
}

function formatAmount(raw: bigint, decimals: number): string {
    if (raw === 0n) return "0";
    const n = Number(formatUnits(raw, decimals));
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
    if (n < 0.0001) return "<0.0001";
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
