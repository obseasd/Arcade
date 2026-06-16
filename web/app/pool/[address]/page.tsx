"use client";

import { ArrowLeft, ExternalLink, Plus, TrendingUp, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, isAddress, zeroAddress } from "viem";
import { useAccount, useReadContract } from "wagmi";

import { PAIR_ABI } from "@/lib/abis/dex";
import { V3_NPM_ABI, V3_POOL_ABI } from "@/lib/abis/v3-npm";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { tickToPriceWithDecimals } from "@/lib/v3-math";
import { cn, formatAddress, formatUsd } from "@/lib/utils";
import { PoolAutoManagementInline } from "@/components/pool/PoolAutoManagementInline";
import { RemoveLiquidityModalV3 } from "@/components/pool/RemoveLiquidityModalV3";

const USDC_LOWER = ADDRESSES.usdc.toLowerCase();

/**
 * Generic pair / pool detail page. Reads the contract directly so any address
 * routed here (post-add toast, deep link, explore Open Pool button) renders
 * even before an indexer has caught up. Both V2 pairs and V3 pools expose
 * token0/token1, so token reads work for both. V3 detection happens via a
 * slot0() probe - if it succeeds, the page renders a concentrated-liquidity
 * panel (current price, raw token reserves) instead of the V2-only
 * reserves/totalSupply/share triad which would read as zero on a V3 pool.
 */
export default function PoolDetailPage() {
    const params = useParams<{ address: string }>();
    const searchParams = useSearchParams();
    // ?tokenId=N hash from the V3Positions Manage button. Lets the
    // auto-management section show settings for the SPECIFIC NFT the
    // user came to manage, rather than the first one in the pool
    // (which read as "this is the auto-management for token X" when
    // the user's intent was actually token Y). null when arrived
    // via deep link, search, or any other non-Manage path.
    const focusTokenIdParam = searchParams?.get("tokenId") ?? null;
    const focusTokenId =
        focusTokenIdParam && /^\d+$/.test(focusTokenIdParam)
            ? focusTokenIdParam
            : null;
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
    // V3 detection probe. slot0() exists on V3 pools but not V2 pairs.
    // If this succeeds, we render the V3 layout below.
    const slot0Q = useReadContract({
        address: pair,
        abi: V3_POOL_ABI,
        functionName: "slot0",
        query: { enabled: isPair, retry: false },
    });
    const v3FeeQ = useReadContract({
        address: pair,
        abi: V3_POOL_ABI,
        functionName: "fee",
        query: { enabled: isPair, retry: false },
    });
    const isV3 = !!slot0Q.data && !slot0Q.isError;
    const reservesQ = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "getReserves",
        query: { enabled: isPair && !isV3 },
    });
    const totalSupplyQ = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "totalSupply",
        query: { enabled: isPair && !isV3 },
    });
    const lpBalanceQ = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: isPair && !isV3 && !!account },
    });
    // V3 raw token balances (used for the composition card + TVL approx).
    const t0BalQ = useReadContract({
        address: token0Q.data as Address | undefined,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [pair],
        query: { enabled: isPair && isV3 && !!token0Q.data },
    });
    const t1BalQ = useReadContract({
        address: token1Q.data as Address | undefined,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [pair],
        query: { enabled: isPair && isV3 && !!token1Q.data },
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
    const v3Fee = (v3FeeQ.data as number | undefined) ?? 0;
    // Fee bps shown in the header chip. V2 pairs are always 0.30%; V3 fee
    // tier comes from the pool's fee() function (pip = bps * 100).
    const feeLabel = isV3 ? `${(v3Fee / 10_000).toFixed(2)}%` : "0.30%";
    const versionLabel = isV3 ? "v3" : "v2";
    const addLiqHref = token0 && token1
        ? isV3
            ? `/positions/add?type=v3&t0=${token0}&t1=${token1}&fee=${Math.round(v3Fee / 100)}`
            : `/positions/add?type=amm&t0=${token0}&t1=${token1}`
        : "/positions/add";
    // V3 current price + range info derived from slot0 + token decimals.
    const v3Tick = slot0Q.data
        ? Number((slot0Q.data as readonly [bigint, number, ...unknown[]])[1])
        : 0;
    const v3CurrentPrice = isV3 && token0Meta && token1Meta
        ? tickToPriceWithDecimals(v3Tick, token0Meta.decimals, token1Meta.decimals)
        : 0;
    // When the user arrived via Manage on a specific position card, fetch
    // that NFT's full state so the Remove button can pop the modal with
    // accurate liquidity / ticks / tokensOwed. Skipped on V2 pools and
    // when the URL has no tokenId hint.
    const positionQ = useReadContract({
        address: ADDRESSES.v3PositionManager,
        abi: V3_NPM_ABI,
        functionName: "positions",
        args:
            focusTokenId && isV3 && ADDRESSES.v3PositionManager !== zeroAddress
                ? [BigInt(focusTokenId)]
                : undefined,
        query: {
            enabled:
                !!focusTokenId &&
                isV3 &&
                ADDRESSES.v3PositionManager !== zeroAddress,
        },
    });
    const positionTuple = positionQ.data as
        | readonly [
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
          ]
        | undefined;
    const positionLiquidity = positionTuple?.[7] ?? 0n;
    const positionTickLower = positionTuple ? Number(positionTuple[5]) : 0;
    const positionTickUpper = positionTuple ? Number(positionTuple[6]) : 0;
    const positionTokensOwed0 = positionTuple?.[10] ?? 0n;
    const positionTokensOwed1 = positionTuple?.[11] ?? 0n;
    const canRemove =
        !!focusTokenId &&
        isV3 &&
        !!positionTuple &&
        positionLiquidity > 0n;

    const [removeOpen, setRemoveOpen] = useState(false);

    const v3T0Bal = (t0BalQ.data as bigint | undefined) ?? 0n;
    const v3T1Bal = (t1BalQ.data as bigint | undefined) ?? 0n;
    // V3 TVL ~= USDC side x 2. Pick whichever leg is USDC.
    const v3Tvl =
        isV3 && token0 && token1
            ? token0.toLowerCase() === USDC_LOWER
                ? v3T0Bal * 2n
                : token1.toLowerCase() === USDC_LOWER
                  ? v3T1Bal * 2n
                  : 0n
            : 0n;

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
                            <span
                                className={cn(
                                    "rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
                                    isV3
                                        ? "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover"
                                        : "border-cyan-400/40 bg-cyan-400/10 text-cyan-400",
                                )}
                            >
                                {versionLabel}
                            </span>
                            <span className="rounded-md border border-arc-success/40 bg-arc-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-arc-success">
                                {feeLabel}
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
                    {/* Remove button surfaces ONLY when the user arrived
                        via Manage on a specific position card (URL
                        carries ?tokenId=N) and the NFT actually has
                        liquidity to remove. Sits to the left of Add
                        Liquidity to mirror Hyperswap's pool-detail
                        header ordering. */}
                    {canRemove && (
                        <button
                            type="button"
                            onClick={() => setRemoveOpen(true)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-arc-border bg-white/[0.04] px-4 py-2 text-sm font-semibold text-arc-text transition-colors hover:bg-white/[0.08]"
                        >
                            <Trash2 className="h-4 w-4" />
                            Remove
                        </button>
                    )}
                    <Link
                        href={addLiqHref}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-arc-cta px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                    >
                        <Plus className="h-4 w-4" />
                        Add Liquidity
                    </Link>
                    <Link
                        href={
                            token0 && token1
                                ? `/swap?t0=${token0}&t1=${token1}`
                                : "/swap"
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl border border-arc-border bg-sky-400/10 px-4 py-2 text-sm font-semibold text-sky-400 transition-colors hover:bg-sky-400/20"
                    >
                        <TrendingUp className="h-4 w-4" />
                        Swap
                    </Link>
                </div>
            </div>

            {/* Lazy-mount the Remove modal. The button only renders when
                positionQ resolved with non-zero liquidity, so by the time
                this section runs everything below is guaranteed to be
                defined. */}
            {canRemove && token0 && token1 && token0Meta && token1Meta && (
                <RemoveLiquidityModalV3
                    open={removeOpen}
                    onClose={() => setRemoveOpen(false)}
                    onSuccess={() => {
                        setRemoveOpen(false);
                        void positionQ.refetch();
                    }}
                    tokenId={BigInt(focusTokenId!)}
                    poolAddress={pair}
                    token0={token0}
                    token1={token1}
                    token0Meta={token0Meta}
                    token1Meta={token1Meta}
                    liquidity={positionLiquidity}
                    tickLower={positionTickLower}
                    tickUpper={positionTickUpper}
                    tokensOwed0={positionTokensOwed0}
                    tokensOwed1={positionTokensOwed1}
                />
            )}

            {/* KPI strip. TVL surfaces from on-chain reserves (V2) or
                USDC-leg x 2 (V3); volume/fees ship with ArcLens. */}
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Kpi
                    label="TVL"
                    value={(() => {
                        const tvl = isV3 ? v3Tvl : tvlUsdc;
                        return tvl > 0n ? formatUsd(tvl) : "—";
                    })()}
                />
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
                                        {formatAmount(
                                            isV3 ? v3T0Bal : reserve0,
                                            token0Meta?.decimals ?? 18,
                                        )}
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
                                        {formatAmount(
                                            isV3 ? v3T1Bal : reserve1,
                                            token1Meta?.decimals ?? 18,
                                        )}
                                    </span>
                                }
                            />
                            <div className="border-t border-arc-border" />
                            {isV3 ? (
                                <Row
                                    left={
                                        <span className="text-arc-text-muted">
                                            Current price
                                        </span>
                                    }
                                    right={
                                        <span className="tabular-nums">
                                            {v3CurrentPrice > 0
                                                ? `${v3CurrentPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sym1}/${sym0}`
                                                : "—"}
                                        </span>
                                    }
                                />
                            ) : (
                                <>
                                    <Row
                                        left={
                                            <span className="text-arc-text-muted">
                                                {sym1} per {sym0}
                                            </span>
                                        }
                                        right={
                                            <span className="tabular-nums">
                                                {ratio01 ?? "—"}
                                            </span>
                                        }
                                    />
                                    <Row
                                        left={
                                            <span className="text-arc-text-muted">
                                                {sym0} per {sym1}
                                            </span>
                                        }
                                        right={
                                            <span className="tabular-nums">
                                                {ratio10 ?? "—"}
                                            </span>
                                        }
                                    />
                                </>
                            )}
                        </div>
                    </div>

                    {/* V2 LP balance card. V3 positions are NFTs and aren't
                        scoped to the pool address, so the equivalent panel
                        lives on /positions where the NPM enumeration runs. */}
                    {!isV3 && account ? (
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
                    ) : !isV3 && !account ? (
                        <div className="arc-card p-4 text-sm text-arc-text-muted">
                            Connect a wallet to see your LP balance + share.
                        </div>
                    ) : (
                        <div className="arc-card p-4 text-sm text-arc-text-muted">
                            V3 positions are NFTs - see{" "}
                            <Link
                                href="/positions?tab=concentrated"
                                className="text-arc-cta-hover hover:underline"
                            >
                                Your Positions
                            </Link>{" "}
                            for your liquidity in this pool.
                        </div>
                    )}
                </div>
            </div>

            {/* Inline Auto-management section. Renders only when the
                connected wallet has a managed V3 position whose
                (token0, token1, fee) tuple matches this pool. The
                component handles the API fetch + the on-chain
                setMode / withdrawPosition writes itself, so the pool
                page stays declarative. Hidden entirely for V2 pairs. */}
            {isV3 && (
                <PoolAutoManagementInline
                    poolToken0={token0}
                    poolToken1={token1}
                    poolFeePip={v3Fee || undefined}
                    focusTokenId={focusTokenId}
                />
            )}

        </div>
    );
}

function useTokenMeta(addr: Address | undefined) {
    // 2026-06-15 audit LOW fix: gate the on-chain symbol/decimals reads
    // on enabled: !isUsdc so the USDC leg of every pool (>99% of pools)
    // stops emitting 2 eth_calls per page load. The short-circuit at
    // the bottom of the hook was post-hook so it only affected the
    // return value, not the query enablement.
    const isUsdc = !!addr && addr.toLowerCase() === USDC_LOWER;
    const symQ = useReadContract({
        address: addr,
        abi: erc20Abi,
        functionName: "symbol",
        query: { enabled: !!addr && !isUsdc },
    });
    const decQ = useReadContract({
        address: addr,
        abi: erc20Abi,
        functionName: "decimals",
        query: { enabled: !!addr && !isUsdc },
    });
    if (!addr) return undefined;
    if (isUsdc) {
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

// formatUsd lives in @/lib/utils now.

function formatAmount(raw: bigint, decimals: number): string {
    if (raw === 0n) return "0";
    const n = Number(formatUnits(raw, decimals));
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
    if (n < 0.0001) return "<0.0001";
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
