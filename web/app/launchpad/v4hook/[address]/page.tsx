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
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, isAddress, parseUnits, zeroAddress } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

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
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useArcadeHookCurveState } from "@/lib/hooks/useArcadeHookTokens";
import { useV4TokenStats } from "@/lib/hooks/useV4TokenStats";
import { useV4PoolPrice } from "@/lib/hooks/useV4PoolPrice";
import { useTokenImage, useTokenMetadata } from "@/lib/hooks/useTokenImage";
import { pushToast } from "@/lib/toast";
import { ClankerV4TradePanel } from "@/components/launchpad/ClankerV4TradePanel";
import { TokenActivityPanel } from "@/components/launchpad/TokenActivityPanel";
import { Comments } from "@/components/launchpad/Comments";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { Tooltip } from "@/components/ui/Tooltip";
import { formatAddress, formatToken, formatUSDC } from "@/lib/utils";

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

    const { metadata } = useTokenMetadata(valid ? token : undefined);
    const { image } = useTokenImage(valid ? token : undefined);

    const feeQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "poolFeeOf",
        args: valid ? [token] : undefined,
        query: { enabled: valid },
    });
    const poolFee = Number((feeQ.data as bigint | number | undefined) ?? 0);

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

    const snipe = useMemo(() => {
        if (snipeStartBps === 0 || snipeDecaySeconds === 0 || snipeLaunchedAt === 0) {
            return { active: false, remainingSec: 0, currentBps: 0 };
        }
        const elapsed = nowSec - snipeLaunchedAt;
        if (elapsed >= snipeDecaySeconds) return { active: false, remainingSec: 0, currentBps: 0 };
        const remainingSec = snipeDecaySeconds - Math.max(0, elapsed);
        const currentBps = Math.round((snipeStartBps * remainingSec) / snipeDecaySeconds);
        return { active: true, remainingSec, currentBps };
    }, [snipeStartBps, snipeDecaySeconds, snipeLaunchedAt, nowSec]);

    const name = (nameQ.data as string | undefined) ?? "Unnamed";
    const symbol = (symbolQ.data as string | undefined) ?? "?";
    const isClanker = mode === ARCADE_HOOK_MODE.CLANKER || mode === ARCADE_HOOK_MODE.CLANKER_V3;
    const isPump = mode === ARCADE_HOOK_MODE.PUMP;

    const stats = useV4TokenStats(valid ? token : undefined);
    // Market cap uses the traded price when available, else the pool's SEED price
    // (StateView.getSlot0) so a freshly-launched token shows a real mcap before
    // its first trade instead of a dash.
    const poolPrice = useV4PoolPrice(valid ? token : undefined);
    const effectivePrice = stats.priceUsd ?? poolPrice;
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
                                        <SnipePill active={snipe.active} currentBps={snipe.currentBps} remainingSec={snipe.remainingSec} />
                                    )}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-arc-text-muted">
                                    <span className="break-all sm:hidden">{formatAddress(token)}</span>
                                    <span className="hidden break-all sm:inline">{token}</span>
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
                            {isClanker ? (
                                <>
                                    <Stat label="Swap fee" value={poolFee > 0 ? `${poolFee / 10_000}%` : "-"} hint="Fixed CLANKER tier. 80% creator / 20% treasury." />
                                    <Stat
                                        label="Liquidity"
                                        value={liquidityUsd > 0 ? `$${liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "Locked"}
                                        hint="USDC currently in the locked single-sided V4 pool (net bought). The LP position itself is locked permanently."
                                    />
                                    <Stat label="Type" value="Direct (V4)" hint="No bonding curve: tradable on the canonical V4 pool from launch." />
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

                    {/* Comments */}
                    <Comments token={token} />
                </div>

                {/* Right: trade panel + fees/recipient (order-first on mobile) */}
                <div className="order-first space-y-6 lg:order-none">
                    {isClanker ? (
                        <ClankerV4TradePanel token={token} symbol={symbol} image={image} />
                    ) : (
                        <TradeCard
                            token={token}
                            symbol={symbol}
                            status={status}
                            tokensSold={tokensSold}
                            realUsdcReserve={realUsdcReserve}
                        />
                    )}
                    <FeesRecipientPanel
                        token={token}
                        poolFee={poolFee}
                        totalVolumeUsdc={stats.totalVolumeUsdc}
                        exactFeesUsd={stats.feesUsdc}
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
}: {
    token: Address;
    poolFee: number;
    totalVolumeUsdc: number;
    exactFeesUsd?: number;
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
    const creatorFeesUsd = feesUsd * 0.8;
    const recipientAddr = fo
        ? fo.creator2 !== zeroAddress && Number(fo.creator2Bps) >= 10_000
            ? fo.creator2
            : fo.creator
        : undefined;

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
                        <p className="mt-1 text-[11px] text-arc-text-faint">
                            Fees are held for your @ (USDC in escrow, token side forwarded on claim). If
                            this is your @, connect a wallet and verify on the claim page to receive both.
                        </p>
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
        </div>
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

function SnipePill({ active, currentBps, remainingSec }: { active: boolean; currentBps: number; remainingSec: number }) {
    if (!active) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full border border-arc-text-faint/30 bg-arc-text-faint/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-text-faint">
                <ShieldOff className="h-3 w-3" /> Snipe expired
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-full border border-arc-warn/40 bg-arc-warn/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-warn">
            <ShieldCheck className="h-3 w-3" /> Snipe {(currentBps / 100).toFixed(2)}%
            <Clock className="ml-0.5 h-3 w-3" /> {formatRemaining(remainingSec)}
        </span>
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

// -------------------------------------------------------------------
// Trade card (PUMP bonding curve: direct hook buy/sell during Curving)
// -------------------------------------------------------------------

function TradeCard({
    token,
    symbol,
    status,
    tokensSold,
    realUsdcReserve,
}: {
    token: Address;
    symbol: string;
    status: number | undefined;
    tokensSold: bigint;
    realUsdcReserve: bigint;
}) {
    const { address: account } = useAccount();
    const [tab, setTab] = useState<"buy" | "sell">("buy");
    const [amountStr, setAmountStr] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const isCurving = status === ARCADE_HOOK_STATUS.CURVING;
    const isGraduated = status === ARCADE_HOOK_STATUS.GRADUATED;

    const usdcBalQ = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });
    const tokenBalQ = useReadContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });
    const usdcBalance = (usdcBalQ.data as bigint | undefined) ?? 0n;
    const tokenBalance = (tokenBalQ.data as bigint | undefined) ?? 0n;

    const buyApprove = useApproveIfNeeded(ADDRESSES.usdc, ADDRESSES.arcadeHook);
    const sellApprove = useApproveIfNeeded(token, ADDRESSES.arcadeHook);

    const { writeContractAsync } = useWriteContract();

    const inputDecimals = tab === "buy" ? USDC_DECIMALS : LAUNCHPAD_TOKEN_DECIMALS;
    const amountBn = useMemo(() => {
        try {
            if (!amountStr || Number(amountStr) <= 0) return 0n;
            return parseUnits(amountStr, inputDecimals);
        } catch {
            return 0n;
        }
    }, [amountStr, inputDecimals]);

    const estimateOut = useMemo(() => {
        if (amountBn === 0n) return 0n;
        const virtUsdc = 5_000n * 10n ** BigInt(USDC_DECIMALS);
        const virtToken = 1_000_000_000n * 10n ** BigInt(LAUNCHPAD_TOKEN_DECIMALS);
        const currentUsdc = virtUsdc + realUsdcReserve;
        const currentTokens = virtToken - tokensSold;
        const K = virtUsdc * virtToken;
        if (tab === "buy") {
            const netIn = (amountBn * 9_900n) / 10_000n;
            const newUsdc = currentUsdc + netIn;
            if (newUsdc === 0n) return 0n;
            const newToken = K / newUsdc;
            if (currentTokens <= newToken) return 0n;
            return currentTokens - newToken;
        }
        const newToken = currentTokens + amountBn;
        if (newToken === 0n) return 0n;
        const newUsdc = K / newToken;
        if (currentUsdc <= newUsdc) return 0n;
        const grossOut = currentUsdc - newUsdc;
        return (grossOut * 9_900n) / 10_000n;
    }, [amountBn, realUsdcReserve, tokensSold, tab]);

    const onSubmit = async () => {
        if (!account) {
            pushToast({ kind: "error", title: "Connect wallet first" });
            return;
        }
        if (amountBn === 0n) {
            pushToast({ kind: "error", title: "Enter an amount" });
            return;
        }
        if (!isCurving) {
            pushToast({ kind: "error", title: "Curve closed", message: "This token has graduated. Trade via the V4 router." });
            return;
        }
        setSubmitting(true);
        try {
            if (tab === "buy") {
                if (amountBn > usdcBalance) {
                    pushToast({ kind: "error", title: "Insufficient USDC" });
                    return;
                }
                await buyApprove.ensureAllowance(amountBn);
                await writeContractAsync({
                    address: ADDRESSES.arcadeHook,
                    abi: ARCADE_HOOK_ABI,
                    functionName: "buy",
                    args: [token, amountBn, 0n],
                });
                pushToast({ kind: "info", title: `Buy submitted` });
            } else {
                if (amountBn > tokenBalance) {
                    pushToast({ kind: "error", title: `Insufficient ${symbol}` });
                    return;
                }
                await sellApprove.ensureAllowance(amountBn);
                await writeContractAsync({
                    address: ADDRESSES.arcadeHook,
                    abi: ARCADE_HOOK_ABI,
                    functionName: "sell",
                    args: [token, amountBn, 0n],
                });
                pushToast({ kind: "info", title: `Sell submitted` });
            }
            setAmountStr("");
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Tx failed";
            pushToast({ kind: "error", title: "Failed", message: msg.slice(0, 120) });
        } finally {
            setSubmitting(false);
        }
    };

    const cta = () => {
        if (!account) return "Connect wallet";
        if (isGraduated) return "Curve graduated - use V4 router";
        if (status === ARCADE_HOOK_STATUS.GRADUATION_STARTED) return "Mid-graduation, retry";
        if (amountBn === 0n) return tab === "buy" ? "Enter USDC amount" : `Enter ${symbol} amount`;
        if (submitting) return "Submitting...";
        return tab === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`;
    };

    const ctaDisabled = !account || !isCurving || amountBn === 0n || submitting;

    return (
        <div className="arc-card flex flex-col p-5">
            <div className="mb-4 flex items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1">
                {(["buy", "sell"] as const).map((t) => (
                    <button
                        type="button"
                        key={t}
                        onClick={() => {
                            setTab(t);
                            setAmountStr("");
                        }}
                        className={
                            "flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors " +
                            (tab === t ? "bg-arc-cta text-white" : "text-arc-text-muted hover:text-arc-text")
                        }
                    >
                        {t === "buy" ? "Buy" : "Sell"}
                    </button>
                ))}
            </div>

            <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-4">
                <div className="mb-3 flex items-center justify-between text-xs text-arc-text-muted">
                    <span>{tab === "buy" ? "Spend" : "Sell"}</span>
                    <span>
                        {tab === "buy"
                            ? `${formatUSDC(usdcBalance, USDC_DECIMALS, 2)} USDC`
                            : `${formatToken(tokenBalance, LAUNCHPAD_TOKEN_DECIMALS, 4)} ${symbol}`}
                    </span>
                </div>
                <input
                    type="text"
                    inputMode="decimal"
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="0.0"
                    className="arc-input w-full bg-transparent text-3xl font-medium leading-tight sm:text-4xl"
                    aria-label="Amount"
                />
                <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className="text-arc-text-faint">{tab === "buy" ? "USDC" : symbol}</span>
                    <div className="flex gap-1.5">
                        <QuickBtn onClick={() => setAmountStr(formatUnits(tab === "buy" ? usdcBalance / 2n : tokenBalance / 2n, inputDecimals))}>
                            HALF
                        </QuickBtn>
                        <QuickBtn onClick={() => setAmountStr(formatUnits(tab === "buy" ? usdcBalance : tokenBalance, inputDecimals))}>
                            MAX
                        </QuickBtn>
                    </div>
                </div>
            </div>

            <div className="mt-4 rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-3 text-xs text-arc-text-muted">
                <div className="flex items-center justify-between">
                    <span>Estimated out (1% fee included)</span>
                    <span className="text-arc-text tabular-nums">
                        {tab === "buy"
                            ? `${formatToken(estimateOut, LAUNCHPAD_TOKEN_DECIMALS, 4)} ${symbol}`
                            : `${formatUSDC(estimateOut, USDC_DECIMALS, 2)} USDC`}
                    </span>
                </div>
                <div className="mt-1 text-[10px] text-arc-text-faint">
                    Slippage 0% (no min-out guard in MVP). On-chain math is canonical.
                </div>
            </div>

            <button
                type="button"
                onClick={onSubmit}
                disabled={ctaDisabled}
                className={"arc-button-primary mt-5 w-full py-3 text-base font-semibold " + (ctaDisabled ? "cursor-not-allowed opacity-50" : "")}
            >
                {cta()}
            </button>

            <div className="mt-3 text-center text-[10px] text-arc-text-faint">
                Direct curve trade via ArcadeHook. 1% fee, 80% creator / 20% treasury.
            </div>
        </div>
    );
}

function QuickBtn({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="rounded-md bg-arc-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-arc-text-muted hover:bg-arc-cta hover:text-white"
        >
            {children}
        </button>
    );
}
