"use client";

import {
    ArrowLeft,
    ExternalLink,
    Lock,
    ShieldCheck,
    ShieldOff,
    Sparkles,
    Clock,
    HelpCircle,
    Copy,
    Check,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Address, erc20Abi, isAddress, zeroAddress } from "viem";
import { useReadContract, useWriteContract, usePublicClient } from "wagmi";

import {
    ARCADE_HOOK_ABI,
    ARCADE_HOOK_MODE,
    ARCADE_HOOK_STATUS,
} from "@/lib/abis/arcadeHook";
import {
    ADDRESSES,
    V4_HOOK_CURVE_SUPPLY as LAUNCHPAD_CURVE_SUPPLY,
    V4_HOOK_GRADUATION_USDC as LAUNCHPAD_GRADUATION_USDC,
    LAUNCHPAD_TOKEN_DECIMALS,
    LAUNCHPAD_TOTAL_SUPPLY,
    USDC_DECIMALS,
    V4_HOOK_ENABLED,
} from "@/lib/constants";
import { pushToast } from "@/lib/toast";
import { useArcadeHookCurveState } from "@/lib/hooks/useArcadeHookTokens";
import { useV4TokenStats } from "@/lib/hooks/useV4TokenStats";
import { useV4PoolPrice } from "@/lib/hooks/useV4PoolPrice";
import { useTokenImage, useTokenMetadata } from "@/lib/hooks/useTokenImage";
import { ClankerV4TradePanel } from "@/components/launchpad/ClankerV4TradePanel";
import { TokenActivityPanel } from "@/components/launchpad/TokenActivityPanel";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { Tooltip } from "@/components/ui/Tooltip";
import { formatAddress, formatUSDC } from "@/lib/utils";

// PriceChart pulls lightweight-charts (~50 kB); defer it out of the initial
// route bundle, matching the legacy launchpad token page.
const PriceChart = dynamic(
    () => import("@/components/launchpad/PriceChart").then((m) => m.PriceChart),
    { ssr: false, loading: () => <div className="h-[320px] w-full rounded-2xl bg-arc-bg-elevated/50" /> },
);

// Fee split is 80% creator / 20% treasury for BOTH live modes (2026-07-17 model).
const MODE_LABEL: Record<number, string> = {
    [ARCADE_HOOK_MODE.PUMP]: "PUMP · bonding curve",
    [ARCADE_HOOK_MODE.CLANKER]: "CLANKER · direct launch",
    [ARCADE_HOOK_MODE.CLANKER_V3]: "CLANKER V3 (locked LP)",
};

export default function ArcadeHookTokenPage() {
    if (!V4_HOOK_ENABLED) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="rounded-2xl border border-arc-border bg-arc-surface p-8 text-center">
                    <Lock className="mx-auto h-8 w-8 text-arc-text-muted" />
                    <h1 className="mt-4 text-xl font-semibold">ArcadeHook not configured</h1>
                    <Link
                        href="/launchpad"
                        className="mt-6 inline-block rounded-lg border border-arc-border bg-arc-surface px-4 py-2 text-sm hover:border-arc-primary/40"
                    >
                        Back to launchpad
                    </Link>
                </div>
            </div>
        );
    }
    return <Inner />;
}

function Inner() {
    const params = useParams();
    const queryClient = useQueryClient();
    const addrParam = (params.address as string) ?? "";
    const valid = isAddress(addrParam);
    const token = valid ? (addrParam as Address) : (zeroAddress as Address);

    const { status, tokensSold, realUsdcReserve, mode, isLoading } = useArcadeHookCurveState(
        valid ? token : undefined,
    );

    const nameQ = useReadContract({
        address: valid ? token : undefined,
        abi: erc20Abi,
        functionName: "name",
        query: { enabled: valid },
    });
    const symbolQ = useReadContract({
        address: valid ? token : undefined,
        abi: erc20Abi,
        functionName: "symbol",
        query: { enabled: valid },
    });

    const stats = useV4TokenStats(valid ? token : undefined);
    // Resolve image/description from the subgraph metadataURI when available
    // (skips the flaky per-token getLogs scan that left the icon a placeholder);
    // fall back to the scan only until the subgraph has indexed the token.
    const metadataURIOverride = stats.metadataURI || undefined;
    const { metadata } = useTokenMetadata(valid ? token : undefined, metadataURIOverride);
    const { image } = useTokenImage(valid ? token : undefined, metadataURIOverride);

    const feeQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "poolFeeOf",
        args: valid ? [token] : undefined,
        query: { enabled: valid },
    });
    const poolFee = Number((feeQ.data as bigint | number | undefined) ?? 0);

    // Live dynamic fee (bps): graduated PUMP decays 1% -> 0.30% with market cap;
    // poolFeeOf is 0 for PUMP so this is the only source of its real swap fee.
    const dynFeeQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "currentFeeBps",
        args: valid ? [token] : undefined,
        query: { enabled: valid, refetchInterval: 30_000 },
    });
    const dynFeeBps = Number((dynFeeQ.data as bigint | number | undefined) ?? 0);

    // Anti-sniper config (per token): startBps, decaySeconds, launchedAt.
    const snipeQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "snipeConfigs",
        args: valid ? [token] : undefined,
        query: { enabled: valid, refetchInterval: 15_000 },
    });
    const snipeRaw = snipeQ.data as readonly [number, number, bigint] | undefined;
    const snipeStartBps = Number(snipeRaw?.[0] ?? 0);
    const snipeDecaySeconds = Number(snipeRaw?.[1] ?? 0);
    const snipeLaunchedAt = Number(snipeRaw?.[2] ?? 0n);

    const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
    useEffect(() => {
        const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1_000);
        return () => clearInterval(t);
    }, []);

    // Anti-snipe timeline. The hook only sets `launchedAt` at GRADUATION (0 while
    // the PUMP curve is still bonding), because the tax rides the post-graduation
    // V4-router pool that does not exist yet. So a configured-but-not-graduated
    // token is PENDING (arms at graduation), NOT expired -- the old "expired"
    // label wrongly implied the window had already lapsed at launch.
    const snipe = useMemo<{
        kind: "none" | "pending" | "active" | "ended";
        remainingSec: number;
        currentBps: number;
    }>(() => {
        if (snipeStartBps === 0 || snipeDecaySeconds === 0) {
            return { kind: "none", remainingSec: 0, currentBps: 0 };
        }
        if (snipeLaunchedAt === 0) {
            // Configured, but the curve has not graduated yet -> window not armed.
            return { kind: "pending", remainingSec: 0, currentBps: 0 };
        }
        const elapsed = nowSec - snipeLaunchedAt;
        if (elapsed >= snipeDecaySeconds) return { kind: "ended", remainingSec: 0, currentBps: 0 };
        const remainingSec = snipeDecaySeconds - Math.max(0, elapsed);
        const currentBps = Math.round((snipeStartBps * remainingSec) / snipeDecaySeconds);
        return { kind: "active", remainingSec, currentBps };
    }, [snipeStartBps, snipeDecaySeconds, snipeLaunchedAt, nowSec]);

    const name = (nameQ.data as string | undefined) ?? "Unnamed";
    const symbol = (symbolQ.data as string | undefined) ?? "?";
    const isClanker = mode === ARCADE_HOOK_MODE.CLANKER || mode === ARCADE_HOOK_MODE.CLANKER_V3;
    const isPump = mode === ARCADE_HOOK_MODE.PUMP;
    // A graduated PUMP trades on its live V4 pool exactly like CLANKER, so its
    // stats should read like a live market (fee + pool value), not frozen curve
    // progress. (PUMP audit M2.)
    const isGraduatedPump = isPump && status === ARCADE_HOOK_STATUS.GRADUATED;
    const showMarketStats = isClanker || isGraduatedPump;

    // Price source:
    //  - Curving PUMP: no pool exists yet, so use the last CURVE trade price
    //    (stats.priceUsd), falling back to the seed pool price.
    //  - CLANKER / graduated PUMP: the live V4 pool is authoritative, so read
    //    the pool spot (StateView.getSlot0) FIRST. Otherwise a just-graduated
    //    token shows the average price of the final curve buy (e.g. $18k mcap)
    //    instead of the pool's real opening spot (~$60k) -- the curve's marginal
    //    price at graduation, which is where the pool actually seeds. (Audit
    //    2026-07-22: display-only, the pool value + quotes were always correct.)
    const poolPrice = useV4PoolPrice(valid ? token : undefined);

    // LIVE curve spot price for a still-curving PUMP, derived from the ON-CHAIN
    // curve state (polled every 5s) instead of the subgraph's last indexed trade.
    // The Goldsky subgraph runs ~100 blocks (1-3 min) behind Arc's ~1s blocks, so
    // a subgraph-sourced market cap sat frozen for minutes after a buy. The curve
    // is a pure constant product, so its marginal price is exactly
    // (VIRTUAL_USDC + realUsdcReserve) / (VIRTUAL_TOKEN - tokensSold) -- no
    // indexer needed. Must mirror ArcadeV4Curve's virtual reserves.
    const curveSpotPrice = useMemo(() => {
        if (!isPump || status === ARCADE_HOOK_STATUS.GRADUATED) return undefined;
        const currentUsdc = 5_800n * 10n ** BigInt(USDC_DECIMALS) + realUsdcReserve;
        const currentTokens =
            1_135_000_000n * 10n ** BigInt(LAUNCHPAD_TOKEN_DECIMALS) - tokensSold;
        if (currentTokens <= 0n) return undefined;
        // (usdcRaw * 1e18) / tokenRaw == price-per-whole-token * 1e6.
        return Number((currentUsdc * 10n ** 18n) / currentTokens) / 1e6;
    }, [isPump, status, realUsdcReserve, tokensSold]);

    const effectivePrice = showMarketStats
        ? (poolPrice ?? stats.priceUsd)
        : (curveSpotPrice ?? stats.priceUsd ?? poolPrice);
    const mcapLabel = effectivePrice
        ? `$${(effectivePrice * Number(LAUNCHPAD_TOTAL_SUPPLY)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
        : "-";

    // Total pool liquidity = USDC side (net bought) + TOKEN side value. The
    // CLANKER single-sided seed lives as tokens in the canonical V4 PoolManager
    // (singleton), so token.balanceOf(poolManager) is this pool's token depth.
    // Without it the "Liquidity" stat under-reads a fresh single-sided pool.
    const poolTokenBalQ = useReadContract({
        address: valid ? token : undefined,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ADDRESSES.v4PoolManager],
        query: { enabled: valid && ADDRESSES.v4PoolManager !== zeroAddress },
    });
    const tokenInPool = poolTokenBalQ.data as bigint | undefined;
    const tokenSideUsd =
        tokenInPool !== undefined && effectivePrice
            ? (Number(tokenInPool) / 1e18) * effectivePrice
            : 0;
    const liquidityUsd = stats.usdcLiquidity + tokenSideUsd;

    const curvePct = useMemo(() => {
        if (LAUNCHPAD_GRADUATION_USDC === 0n) return 0;
        const bps = (realUsdcReserve * 10_000n) / LAUNCHPAD_GRADUATION_USDC;
        return Math.min(100, Number(bps) / 100);
    }, [realUsdcReserve]);

    if (!valid) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="arc-card p-8 text-center text-arc-danger">
                    Invalid token address: {addrParam}
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
            <Link
                href="/launchpad"
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> Launchpad
            </Link>

            <div className="grid gap-6 lg:grid-cols-3">
                {/* Left: header + chart + activity + comments */}
                <div className="space-y-6 lg:col-span-2">
                    {/* Header */}
                    <div className="arc-card p-6">
                        <div className="flex items-start gap-4">
                            <TokenIcon
                                symbol={symbol}
                                image={image}
                                size={80}
                                className="h-16 w-16 rounded-2xl border border-arc-border sm:h-20 sm:w-20"
                            />
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-2">
                                    <h1 className="truncate text-xl font-semibold sm:text-2xl">{name}</h1>
                                    <span className="tabular-nums text-arc-text-muted">${symbol}</span>
                                    {mode !== undefined && (
                                        <span className="rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-cta-hover">
                                            {MODE_LABEL[mode]}
                                        </span>
                                    )}
                                    <StatusBadge status={status} isClanker={isClanker} />
                                    {snipeStartBps > 0 && (
                                        <SnipePill
                                            kind={snipe.kind}
                                            startBps={snipeStartBps}
                                            decaySeconds={snipeDecaySeconds}
                                            currentBps={snipe.currentBps}
                                            remainingSec={snipe.remainingSec}
                                        />
                                    )}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-arc-text-muted">
                                    <span className="sm:hidden">
                                        <CopyAddress address={token} short />
                                    </span>
                                    <span className="hidden sm:inline">
                                        <CopyAddress address={token} />
                                    </span>
                                </div>
                                {metadata?.description && (
                                    <p className="mt-3 max-w-2xl text-sm text-arc-text-muted">{metadata.description}</p>
                                )}
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                    {poolFee > 0 && <span className="arc-pill cursor-default">Fees: {poolFee / 10_000}%</span>}
                                    <a
                                        href={`https://testnet.arcscan.app/address/${token}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="arc-pill"
                                    >
                                        <ExternalLink className="h-3.5 w-3.5" /> Explorer
                                    </a>
                                </div>
                            </div>
                        </div>

                        {/* Stats row */}
                        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <Stat
                                label="Market cap"
                                value={mcapLabel}
                                hint="Latest indexed price multiplied by the 1B total supply. Equal to FDV since all tokens are circulating from launch."
                            />
                            {showMarketStats ? (
                                <>
                                    <Stat
                                        label="Swap fee"
                                        value={
                                            isClanker
                                                ? poolFee > 0 ? `${poolFee / 10_000}%` : "-"
                                                : dynFeeBps > 0 ? `${(dynFeeBps / 100).toFixed(2)}%` : "1% -> 0.30%"
                                        }
                                        hint={
                                            isClanker
                                                ? "Fixed CLANKER tier. 80% creator / 20% treasury."
                                                : "Live dynamic fee: decays from 1% to 0.30% as market cap grows. 80% creator / 20% treasury."
                                        }
                                    />
                                    <Stat
                                        label="Pool value"
                                        value={liquidityUsd > 0 ? `$${liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "Locked"}
                                        hint="Total value in the V4 pool (USDC net bought plus the token side at the current price). The LP is locked permanently."
                                    />
                                    <Stat
                                        label="Type"
                                        value={isClanker ? "Direct (V4)" : "Graduated (V4)"}
                                        hint={isClanker ? "No bonding curve: tradable on the canonical V4 pool from launch." : "This PUMP graduated: it now trades on its locked full-range V4 pool."}
                                    />
                                </>
                            ) : (
                                <>
                                    <Stat
                                        label={status === ARCADE_HOOK_STATUS.GRADUATED ? "Status" : "Progress"}
                                        value={status === ARCADE_HOOK_STATUS.GRADUATED ? "Graduated" : `${curvePct.toFixed(1)}%`}
                                        hint="Fraction of the graduation target raised on the bonding curve. At 100% the curve seeds a locked full-range V4 LP."
                                    />
                                    <Stat
                                        label="Raised"
                                        value={`$${formatUSDC(realUsdcReserve, USDC_DECIMALS, 0)}`}
                                        hint="USDC accumulated on the curve so far."
                                    />
                                    <Stat
                                        label="Graduation at"
                                        value={`$${formatUSDC(LAUNCHPAD_GRADUATION_USDC, USDC_DECIMALS, 0)}`}
                                        hint="USDC raised at which the curve migrates into a locked V4 LP."
                                    />
                                </>
                            )}
                        </div>

                        {isPump && status !== ARCADE_HOOK_STATUS.GRADUATED && (
                            <div className="mt-4">
                                <div className="h-2 overflow-hidden rounded-full bg-arc-bg-elevated">
                                    <div
                                        className="h-full bg-gradient-to-r from-arc-primary to-arc-primary-hover"
                                        style={{ width: `${Math.min(curvePct, 100)}%` }}
                                    />
                                </div>
                                <div className="mt-1 text-xs text-arc-text-faint">
                                    The curve migrates to a locked full-range V4 LP at 100%.
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Chart */}
                    <div className="arc-card p-5">
                        <PriceChart token={token} mode={mode} source="v4" />
                    </div>

                    {/* Activity: transactions (subgraph) + holders */}
                    <TokenActivityPanel
                        token={token}
                        symbol={symbol}
                        mode={mode}
                        totalSupplyRaw={LAUNCHPAD_TOTAL_SUPPLY * 10n ** 18n}
                        source="v4"
                    />

                    {/* Comments intentionally omitted for V4-hook tokens: the
                        on-chain guestbook lives on the legacy ArcadeLaunchpad and
                        gates postComment on tokens[tokenAddr] registration, which
                        the hook never populates -> every post reverts
                        UnknownToken(). Restore with an off-chain store or a
                        hook-side comment registry. */}
                </div>

                {/* Right: trade panel + fees/recipient (order-first on mobile) */}
                <div className="order-first space-y-6 lg:order-none">
                    {/* One panel for every venue. CLANKER + graduated PUMP trade on
                        the canonical V4 pool via the router; a still-curving PUMP
                        passes its curve state so the SAME panel routes to the hook's
                        bonding-curve buy/sell. onTradeSuccess invalidates the reads
                        so balances, curve progress and holders refresh in place
                        (no manual page refresh to sell or see new holders). */}
                    <ClankerV4TradePanel
                        token={token}
                        symbol={symbol}
                        image={image}
                        curve={
                            isPump && status !== ARCADE_HOOK_STATUS.GRADUATED
                                ? { tokensSold, realUsdcReserve }
                                : undefined
                        }
                        onTradeSuccess={() => queryClient.invalidateQueries()}
                    />
                    <FeesRecipientPanel
                        token={token}
                        poolFee={poolFee}
                        totalVolumeUsdc={stats.totalVolumeUsdc}
                        exactFeesUsd={stats.feesUsdc}
                        isCurvePhase={isPump && status === ARCADE_HOOK_STATUS.CURVING}
                    />
                </div>
            </div>

            {isLoading && (
                <div className="mt-4 text-center text-xs text-arc-text-faint">Loading token state...</div>
            )}
        </div>
    );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="rounded-xl border border-arc-border bg-arc-bg-elevated p-3">
            <div className="flex items-center gap-1 text-xs text-arc-text-muted">
                {label}
                {hint && (
                    <Tooltip content={hint}>
                        <HelpCircle className="h-3 w-3 text-arc-text-faint" aria-label="Definition" />
                    </Tooltip>
                )}
            </div>
            <div className="mt-1 truncate tabular-nums text-base font-medium">{value}</div>
        </div>
    );
}

// -------------------------------------------------------------------
// Fees generated + recipient (under the trade panel)
// -------------------------------------------------------------------

/** Total swap fees this token has generated, plus who receives the creator cut:
 *  a wallet (the launcher, or a full-route creator2) or a Twitter @handle (via
 *  the handle-gated escrow -- clicking through to /claim lets the real owner
 *  verify and collect). Fees = traded volume x fee rate (exact for CLANKER's
 *  static tier; an estimate at 1% for PUMP's dynamic fee). */
function FeesRecipientPanel({
    token,
    poolFee,
    totalVolumeUsdc,
    exactFeesUsd,
    isCurvePhase,
}: {
    token: Address;
    poolFee: number;
    totalVolumeUsdc: number;
    exactFeesUsd?: number;
    isCurvePhase: boolean;
}) {
    const poolIdQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "poolIdOf",
        args: [token],
        query: { enabled: token !== zeroAddress },
    });
    const poolId = poolIdQ.data as `0x${string}` | undefined;

    const feeOwnerQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "getFeeOwner",
        args: poolId ? [poolId] : undefined,
        query: { enabled: !!poolId },
    });
    const fo = feeOwnerQ.data as
        | { creator: Address; creator2: Address; creator2Bps: number; twitterEscrow: Address }
        | undefined;

    const isTwitter = !!fo && fo.twitterEscrow !== zeroAddress;

    // Handle string only lives in the subgraph (HandleAttribution). Fetch it when
    // the fees route to a twitter escrow so we can show the @ and link to /claim.
    const [handle, setHandle] = useState<string>();
    useEffect(() => {
        const url = process.env.NEXT_PUBLIC_GOLDSKY_URL;
        if (!url || !isTwitter) return;
        let cancelled = false;
        const q = `{ handleAttributions(first: 1, where: { token: "${token.toLowerCase()}" }) { handle } }`;
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
                if (cancelled) return;
                const h = j?.data?.handleAttributions?.[0]?.handle;
                if (h) setHandle(String(h).replace(/^@/, ""));
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [isTwitter, token]);

    // Fees GENERATED by the token = traded volume x the swap-fee rate. For a
    // CLANKER static tier this is exact; for PUMP's dynamic fee it's a ~1%
    // estimate. (The subgraph's Token.feesUsdc tracks fees DISTRIBUTED via
    // harvest, a different number that stays 0 until someone collects -- so we
    // don't use it here; exactFeesUsd is only shown when a real harvest exists.)
    const feeRate = poolFee > 0 ? poolFee / 1_000_000 : 0.01;
    const estimated = totalVolumeUsdc * feeRate;
    const feesUsd = exactFeesUsd != null && exactFeesUsd > estimated ? exactFeesUsd : estimated;
    const isEstimate = poolFee === 0 && !(exactFeesUsd != null && exactFeesUsd > estimated);
    // The recipient (creator) gets 80% of the fee; treasury takes 20% (the V4
    // post-graduation split). "Fees generated" shows the CREATOR portion only.
    // The DISPLAYED recipient's share of the 80% creator cut. creator2Bps=10000
    // ("Another wallet") => recipient IS creator2, gets the full 80%. A partial
    // creator2Bps (reply-split 5000) => the shown launcher only gets the
    // remainder (e.g. 40%). Solo => full 80%.
    const c2bps = fo ? Number(fo.creator2Bps) || 0 : 0;
    const recipientShare = c2bps >= 10_000 ? 1 : (10_000 - c2bps) / 10_000;
    // Creator's share of the fee: the PUMP bonding CURVE splits 50/50
    // platform/creator, but the post-graduation AMM (and CLANKER) splits 80/20
    // creator/treasury. Use the right split for the phase so a curving PUMP does
    // not overstate the creator cut. (PUMP audit L1.)
    const creatorFeePortion = isCurvePhase ? 0.5 : 0.8;
    const creatorFeesUsd = feesUsd * creatorFeePortion * recipientShare;
    const recipientAddr = fo
        ? fo.creator2 !== zeroAddress && Number(fo.creator2Bps) >= 10_000
            ? fo.creator2
            : fo.creator
        : undefined;

    // CLANKER creators realize their 80% fee cut only when collectFees(token)
    // runs -- it's permissionless and always pays the configured recipient, so
    // a wallet-recipient creator can harvest right here instead of the fees
    // sitting locked in the LP forever. Only shown once the position is seeded.
    const clankerPosQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "clankerPos",
        args: [token],
        query: { enabled: token !== zeroAddress },
    });
    const seeded = Boolean((clankerPosQ.data as readonly [number, number, boolean] | undefined)?.[2]);
    const publicClient = usePublicClient();
    const { writeContractAsync } = useWriteContract();
    const [collecting, setCollecting] = useState(false);
    const onCollect = async () => {
        setCollecting(true);
        try {
            const hash = await writeContractAsync({
                address: ADDRESSES.arcadeHook,
                abi: ARCADE_HOOK_ABI,
                functionName: "collectFees",
                args: [token],
            });
            if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
            pushToast({ kind: "info", title: "Fees collected", message: "Harvested to the creator recipient." });
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Failed";
            pushToast({ kind: "error", title: "Collect failed", message: msg.slice(0, 140) });
        } finally {
            setCollecting(false);
        }
    };

    return (
        <div className="arc-card space-y-3 p-5">
            <div className="flex items-center justify-between text-sm">
                <span className="text-arc-text-muted">Fees generated</span>
                <span className="tabular-nums font-medium">
                    ${creatorFeesUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    {isEstimate && <span className="text-[10px] text-arc-text-faint"> (est.)</span>}
                </span>
            </div>
            <div className="border-t border-arc-border pt-3">
                <div className="text-xs text-arc-text-muted">Fees recipient</div>
                {isTwitter ? (
                    <>
                        <Link
                            href={`/claim?token=${token}&slot=0${handle ? `&handle=${handle}` : ""}`}
                            className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-arc-cta-hover hover:underline"
                        >
                            @{handle ?? "twitter"} · verify &amp; claim
                        </Link>
                    </>
                ) : recipientAddr ? (
                    <a
                        href={`https://testnet.arcscan.app/address/${recipientAddr}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block truncate font-mono text-sm text-arc-text hover:text-arc-cta-hover"
                    >
                        {formatAddress(recipientAddr)}
                    </a>
                ) : (
                    <div className="mt-1 text-sm text-arc-text-faint">-</div>
                )}
            </div>
            {seeded && (
                <div className="border-t border-arc-border pt-3">
                    <button
                        type="button"
                        onClick={onCollect}
                        disabled={collecting}
                        className={
                            "w-full rounded-lg border border-arc-border bg-arc-surface px-4 py-2 text-sm font-medium transition-colors hover:border-arc-cta-hover " +
                            (collecting ? "cursor-not-allowed opacity-50" : "")
                        }
                    >
                        {collecting ? "Collecting..." : "Collect fees"}
                    </button>
                    <p className="mt-1 text-[10px] text-arc-text-faint">
                        Harvests the locked LP's accrued fees to the recipient above. Permissionless: anyone can trigger it.
                    </p>
                </div>
            )}
        </div>
    );
}

// -------------------------------------------------------------------
// Copy-to-clipboard address
// -------------------------------------------------------------------

/** The token contract address, click-to-copy with a check-mark flip. */
function CopyAddress({ address, short }: { address: string; short?: boolean }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(address);
        } catch {
            return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
    };
    return (
        <button
            type="button"
            onClick={copy}
            title="Copy contract address"
            className="group inline-flex items-center gap-1 rounded-md px-1 py-0.5 font-mono transition-colors hover:bg-arc-cta-hover/10 hover:text-arc-text"
        >
            <span className="break-all">{short ? formatAddress(address) : address}</span>
            <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                <Copy
                    className={`absolute h-3.5 w-3.5 transition-all duration-200 ${copied ? "scale-0 opacity-0" : "scale-100 opacity-60 group-hover:opacity-100"}`}
                />
                <Check
                    className={`absolute h-3.5 w-3.5 text-arc-success transition-all duration-200 ${copied ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
                />
            </span>
            {copied && <span className="text-[10px] text-arc-success">Copied</span>}
        </button>
    );
}

// -------------------------------------------------------------------
// Badges
// -------------------------------------------------------------------

/** CLANKER is a live direct-launch pool with no lifecycle badge (the mode pill
 *  already says "direct launch"). PUMP shows the bonding-curve lifecycle. */
function StatusBadge({ status, isClanker }: { status: number | undefined; isClanker: boolean }) {
    if (isClanker) return null;
    if (status === ARCADE_HOOK_STATUS.CURVING) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-cta-hover">
                <Sparkles className="h-3 w-3" /> Curving
            </span>
        );
    }
    if (status === ARCADE_HOOK_STATUS.GRADUATED) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full border border-arc-success/40 bg-arc-success/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-success">
                <ShieldCheck className="h-3 w-3" /> Graduated
            </span>
        );
    }
    if (status === ARCADE_HOOK_STATUS.GRADUATION_STARTED) {
        return (
            <span className="rounded-full border border-arc-warn/40 bg-arc-warn/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-warn">
                Graduating
            </span>
        );
    }
    return null;
}

function SnipePill({
    kind,
    startBps,
    decaySeconds,
    currentBps,
    remainingSec,
}: {
    kind: "none" | "pending" | "active" | "ended";
    startBps: number;
    decaySeconds: number;
    currentBps: number;
    remainingSec: number;
}) {
    if (kind === "none") return null;

    // Configured but the curve has not graduated yet: the tax arms AT graduation.
    if (kind === "pending") {
        return (
            <Tooltip
                content={`Anti-snipe armed for graduation: the first buyers on the V4 pool pay a ${(startBps / 100).toFixed(0)}% tax that decays to 0 over ${formatRemaining(decaySeconds)} after this token graduates. It has NOT started yet (the curve is still bonding).`}
            >
                <span className="inline-flex cursor-help items-center gap-1 rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-cta-hover">
                    <ShieldCheck className="h-3 w-3" /> Snipe guard · at graduation
                </span>
            </Tooltip>
        );
    }

    // Window elapsed after graduation.
    if (kind === "ended") {
        return (
            <Tooltip
                content={`Anti-snipe finished: a ${(startBps / 100).toFixed(0)}% early-buyer tax ran for ${formatRemaining(decaySeconds)} after graduation and has now decayed to 0. Trading is untaxed by the guard.`}
            >
                <span className="inline-flex cursor-help items-center gap-1 rounded-full border border-arc-text-faint/30 bg-arc-text-faint/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-text-faint">
                    <ShieldOff className="h-3 w-3" /> Snipe guard · ended
                </span>
            </Tooltip>
        );
    }

    // Live: currently taxing early buyers.
    return (
        <Tooltip content={`Early-buyer tax live: currently ${(currentBps / 100).toFixed(2)}%, decaying to 0 in ${formatRemaining(remainingSec)}.`}>
            <span className="inline-flex cursor-help items-center gap-1 rounded-full border border-arc-warn/40 bg-arc-warn/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-warn">
                <ShieldCheck className="h-3 w-3" /> Snipe {(currentBps / 100).toFixed(2)}%
                <Clock className="ml-0.5 h-3 w-3" /> {formatRemaining(remainingSec)}
            </span>
        </Tooltip>
    );
}

function formatRemaining(seconds: number): string {
    if (seconds <= 0) return "0s";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (minutes < 60) return s > 0 ? `${minutes}m ${s}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
}
