"use client";

import {
    ArrowLeft,
    ArrowRight,
    Copy,
    ExternalLink,
    MoreHorizontal,
    Rocket,
    Share2,
    TrendingUp,
    Wallet,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
    Area,
    AreaChart,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    XAxis,
    YAxis,
} from "recharts";
import { Address, formatUnits } from "viem";
import { useAccount } from "wagmi";
import { TokenCard } from "@/components/launchpad/TokenCard";
import { CreatorEarningsCard } from "@/components/pool/CreatorEarningsCard";
import { CreatorFeesPanel } from "@/components/pool/CreatorFeesPanel";
import { PendingWithdrawalsCard } from "@/components/pool/PendingWithdrawalsCard";
import { VaultClaimPanel } from "@/components/pool/VaultClaimPanel";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { LAUNCHPAD_TOKEN_DECIMALS, USDC_DECIMALS } from "@/lib/constants";
import { useLaunchpadTokens } from "@/lib/hooks/useLaunchpadTokens";
import { useMyHoldings, type HoldingInfo } from "@/lib/hooks/useMyHoldings";
import { loadBridgeHistory, type HistoryEntry } from "@/lib/bridgeHistory";
import { listPendingClaims, type PendingTwitterClaim } from "@/lib/pendingClaims";
import { iconForActivity, loadActivity, type ActivityEntry } from "@/lib/activityFeed";
import { pushToast } from "@/lib/toast";
import { cn, formatAddress, formatToken, formatUSDC } from "@/lib/utils";

const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

type TabKey = "overview" | "tokens" | "creator" | "activity";

const TABS: { key: TabKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "tokens", label: "Tokens" },
    { key: "creator", label: "Creator" },
    { key: "activity", label: "Activity" },
];

export default function MyTokensPage() {
    const { address: account } = useAccount();
    const { tokens, isLoading } = useLaunchpadTokens();
    const { holdings, isLoading: holdingsLoading } = useMyHoldings();
    const [tab, setTab] = useState<TabKey>("overview");

    const mine = useMemo(() => {
        if (!account) return [];
        const acc = account.toLowerCase();
        return tokens.filter((t) => t.creator.toLowerCase() === acc);
    }, [tokens, account]);

    const totalHoldingsUsd = useMemo(() => {
        let total = 0n;
        for (const h of holdings) {
            if (h.valueUsdcRaw !== undefined) total += h.valueUsdcRaw;
        }
        return total;
    }, [holdings]);

    return (
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
            <Link
                href="/launchpad"
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> Launchpad
            </Link>

            <PortfolioHeader account={account} />

            <PortfolioTabs current={tab} onChange={setTab} />

            {!account ? (
                <div className="arc-card p-6 text-center text-sm text-arc-text-muted sm:p-12">
                    Connect your wallet to see your portfolio.
                </div>
            ) : tab === "overview" ? (
                <OverviewTab
                    account={account}
                    holdings={holdings}
                    totalHoldingsUsd={totalHoldingsUsd}
                    launchedCount={mine.length}
                    onShowAllTokens={() => setTab("tokens")}
                    onShowAllActivity={() => setTab("activity")}
                />
            ) : tab === "tokens" ? (
                <TokensTab
                    holdings={holdings}
                    totalHoldingsUsd={totalHoldingsUsd}
                    loading={holdingsLoading}
                />
            ) : tab === "creator" ? (
                <CreatorTab mine={mine} loading={isLoading} />
            ) : (
                <ActivityTab account={account} />
            )}
        </div>
    );
}

// ============================ Header ============================

function PortfolioHeader({ account }: { account: Address | undefined }) {
    const explorerUrl = account
        ? `https://testnet.arcscan.app/address/${account}`
        : undefined;

    const onShare = async () => {
        if (!account) return;
        try {
            await navigator.clipboard.writeText(account);
            pushToast({ kind: "info", title: "Address copied" });
        } catch {
            pushToast({ kind: "error", title: "Couldn't copy" });
        }
    };

    return (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-arc-primary to-arc-cta text-base font-bold text-white">
                    {account ? account.slice(2, 3).toUpperCase() : "?"}
                </div>
                <div>
                    <div className="text-lg font-semibold sm:text-xl">
                        {account ? formatAddress(account) : "Not connected"}
                    </div>
                    <div className="text-xs text-arc-text-faint">My portfolio</div>
                </div>
            </div>
            <div className="flex items-center gap-2">
                {account && (
                    <>
                        <button
                            onClick={onShare}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-1.5 text-xs font-medium text-arc-text transition-colors hover:bg-white/5"
                        >
                            <Share2 className="h-3.5 w-3.5" />
                            Share
                        </button>
                        {explorerUrl && (
                            <a
                                href={explorerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="View on Arcscan"
                                className="inline-flex items-center justify-center rounded-xl border border-arc-border bg-arc-bg-elevated p-1.5 text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                        )}
                        <button
                            title="More"
                            disabled
                            className="inline-flex items-center justify-center rounded-xl border border-arc-border bg-arc-bg-elevated p-1.5 text-arc-text-faint opacity-50"
                        >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

// ============================ Tabs nav ============================

function PortfolioTabs({ current, onChange }: { current: TabKey; onChange: (k: TabKey) => void }) {
    return (
        <div className="mb-6 flex gap-1 border-b border-arc-border/60">
            {TABS.map((t) => (
                <button
                    key={t.key}
                    onClick={() => onChange(t.key)}
                    className={cn(
                        "relative px-4 py-3 text-sm font-medium transition-colors",
                        current === t.key
                            ? "text-arc-text"
                            : "text-arc-text-muted hover:text-arc-text",
                    )}
                >
                    {t.label}
                    {current === t.key && (
                        <span className="absolute inset-x-2 bottom-[-1px] h-0.5 rounded-full bg-arc-cta-hover" />
                    )}
                </button>
            ))}
        </div>
    );
}

// ============================ Overview tab ============================

/**
 * Pure placeholder pseudo-random walk anchored to the current portfolio
 * value. Real historical USD value over time requires the indexer to land;
 * this is a visual stand-in so the Overview chart doesn't look like an
 * empty card. Deterministic per value so the same wallet sees the same
 * curve across refreshes (we seed off the integer truncation of `current`).
 */
function generatePlaceholderSeries(current: number, points = 32): { x: number; y: number }[] {
    if (current <= 0) {
        // Empty wallets get a flat-ish baseline so the chart still renders.
        return Array.from({ length: points }, (_, i) => ({ x: i, y: 1 + Math.sin(i / 3) * 0.05 }));
    }
    const seed = Math.floor(current * 100) || 1;
    const data: { x: number; y: number }[] = [];
    let v = current * 0.93;
    for (let i = 0; i < points - 1; i++) {
        const noise =
            Math.sin((i + seed) * 1.31) * 0.012 + Math.cos((i + seed) * 0.71) * 0.018;
        v = Math.max(0.01, v * (1 + noise));
        data.push({ x: i, y: v });
    }
    data.push({ x: points - 1, y: current });
    return data;
}

function OverviewTab({
    account,
    holdings,
    totalHoldingsUsd,
    launchedCount,
    onShowAllTokens,
    onShowAllActivity,
}: {
    account: Address;
    holdings: HoldingInfo[];
    totalHoldingsUsd: bigint;
    launchedCount: number;
    onShowAllTokens: () => void;
    onShowAllActivity: () => void;
}) {
    const currentUsd = Number(totalHoldingsUsd) / 1e6;
    const series = useMemo(() => generatePlaceholderSeries(currentUsd), [currentUsd]);

    // Daily change: compare last to ~24h ago in the placeholder. Real value
    // would come from the indexer; this exists so the layout has the right
    // shape and so Realized/Total P/L compute without throwing.
    const firstY = series[0]?.y ?? currentUsd;
    const dailyDelta = currentUsd - firstY;
    const dailyPct = firstY > 0 ? (dailyDelta / firstY) * 100 : 0;
    const dailyDown = dailyDelta < 0;

    // Performance placeholders. Unrealized = "what holdings are worth now
    // minus a notional cost basis we don't have"; we surface a small portion
    // of the current value as a fake unrealized return. Realized = 0 since
    // we don't track historical trades. Total = sum. The indexer will
    // replace this with real numbers.
    const unrealized = dailyDelta;
    const realized = 0;
    const total = unrealized + realized;

    return (
        <div className="grid gap-6 lg:grid-cols-3">
            {/* Left: hero + chart + performance + previews */}
            <div className="space-y-6 lg:col-span-2">
                <div className="arc-card p-5 sm:p-6">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="truncate text-4xl font-semibold tabular-nums sm:text-5xl">
                                ${currentUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </div>
                            <div
                                className={cn(
                                    "mt-1 flex items-center gap-1 text-xs",
                                    dailyDown ? "text-arc-danger" : "text-arc-success",
                                )}
                            >
                                {dailyDown ? "▼" : "▲"}{" "}
                                ${Math.abs(dailyDelta).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                                ({dailyPct.toFixed(2)}%) today
                                <span className="ml-2 text-arc-text-faint">· placeholder, waiting for indexer</span>
                            </div>
                        </div>
                    </div>

                    <div className="mt-4 h-40 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={series}>
                                <defs>
                                    <linearGradient id="portfolioFill" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#15508F" stopOpacity={0.4} />
                                        <stop offset="100%" stopColor="#15508F" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <XAxis dataKey="x" hide />
                                <YAxis hide domain={["dataMin", "dataMax"]} />
                                <RechartsTooltip
                                    cursor={false}
                                    contentStyle={{
                                        background: "rgba(6, 26, 54, 0.95)",
                                        border: "1px solid rgba(40, 60, 90, 0.6)",
                                        borderRadius: 8,
                                        fontSize: 11,
                                        padding: "4px 8px",
                                    }}
                                    formatter={(v: number) => [`$${v.toFixed(2)}`, ""]}
                                    labelFormatter={() => ""}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="y"
                                    stroke="#15508F"
                                    strokeWidth={2}
                                    fill="url(#portfolioFill)"
                                    isAnimationActive={false}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Timeframe row (visual only) */}
                    <div className="mt-3 flex items-center gap-1 text-xs text-arc-text-muted">
                        {["1H", "1D", "1W", "1M", "1Y", "All"].map((label) => (
                            <button
                                key={label}
                                disabled
                                className={cn(
                                    "rounded-md px-2 py-1 font-medium",
                                    label === "1D"
                                        ? "bg-arc-cta-hover/15 text-arc-cta-hover"
                                        : "text-arc-text-faint",
                                )}
                            >
                                {label}
                            </button>
                        ))}
                        <span className="ml-2 text-[10px] text-arc-text-faint">
                            real history unlocks with the indexer
                        </span>
                    </div>
                </div>

                {/* Performance card */}
                <div className="arc-card p-5 sm:p-6">
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                        <TrendingUp className="h-4 w-4" />
                        Performance
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <PerfRow label="Unrealized return" value={unrealized} />
                        <PerfRow label="Realized return" value={realized} />
                        <PerfRow label="Total return" value={total} />
                    </div>
                    <div className="mt-3 text-[10px] text-arc-text-faint">
                        Placeholder — real P/L requires the indexer to compute cost basis
                        from historical trades.
                    </div>
                </div>

                {/* Tokens preview */}
                <div className="arc-card p-5 sm:p-6">
                    <div className="mb-3 flex items-center justify-between">
                        <div>
                            <div className="text-sm font-semibold">Tokens</div>
                            <div className="text-xs text-arc-text-faint">
                                {holdings.length} held{launchedCount > 0 ? ` · ${launchedCount} launched` : ""}
                            </div>
                        </div>
                        <button
                            onClick={onShowAllTokens}
                            className="inline-flex items-center gap-1 rounded-xl border border-arc-border px-3 py-1.5 text-xs text-arc-text-muted hover:bg-white/5 hover:text-arc-text"
                        >
                            View all tokens
                            <ArrowRight className="h-3 w-3" />
                        </button>
                    </div>
                    <TokensTablePreview holdings={holdings.slice(0, 5)} />
                </div>
            </div>

            {/* Right column: recent activity */}
            <div className="space-y-6 lg:col-span-1">
                <div className="arc-card p-5 sm:p-6">
                    <div className="mb-3 flex items-center justify-between">
                        <div>
                            <div className="text-sm font-semibold">Recent activity</div>
                        </div>
                        <button
                            onClick={onShowAllActivity}
                            className="inline-flex items-center gap-1 rounded-xl border border-arc-border px-3 py-1.5 text-xs text-arc-text-muted hover:bg-white/5 hover:text-arc-text"
                        >
                            View all
                            <ArrowRight className="h-3 w-3" />
                        </button>
                    </div>
                    <ActivityList account={account} limit={6} />
                </div>
            </div>
        </div>
    );
}

function PerfRow({ label, value }: { label: string; value: number }) {
    const positive = value > 0;
    const negative = value < 0;
    return (
        <div className="rounded-xl border border-arc-border bg-arc-bg-elevated p-3">
            <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">{label}</div>
            <div
                className={cn(
                    "mt-1 text-lg font-semibold tabular-nums",
                    positive ? "text-arc-success" : negative ? "text-arc-danger" : "text-arc-text",
                )}
            >
                {positive ? "+" : ""}
                ${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
        </div>
    );
}

// ============================ Tokens tab ============================

function TokensTab({
    holdings,
    totalHoldingsUsd,
    loading,
}: {
    holdings: HoldingInfo[];
    totalHoldingsUsd: bigint;
    loading: boolean;
}) {
    if (loading && holdings.length === 0) {
        return (
            <div className="arc-card p-8 text-center text-sm text-arc-text-muted">Loading…</div>
        );
    }
    if (holdings.length === 0) {
        return (
            <div className="arc-card p-6 text-center sm:p-12">
                <Wallet className="mx-auto mb-3 h-8 w-8 text-arc-text-faint" />
                <p className="text-sm text-arc-text-muted">
                    No tokens in this wallet yet. Bridge USDC and start trading.
                </p>
                <div className="mt-4 flex justify-center gap-2">
                    <Link
                        href="/launchpad"
                        className="arc-button-primary inline-block px-5 py-2 text-sm"
                    >
                        Browse launchpad
                    </Link>
                </div>
            </div>
        );
    }
    return (
        <div className="space-y-3">
            <div className="text-xs text-arc-text-muted">
                {holdings.length} token{holdings.length === 1 ? "" : "s"}
                {totalHoldingsUsd > 0n && (
                    <>
                        {" · approx "}
                        <span className="text-arc-text">
                            ${(Number(totalHoldingsUsd) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                    </>
                )}
            </div>
            <TokensTablePreview holdings={holdings} />
        </div>
    );
}

function TokensTablePreview({ holdings }: { holdings: HoldingInfo[] }) {
    if (holdings.length === 0) {
        return (
            <div className="text-xs text-arc-text-faint">
                No tokens held yet.
            </div>
        );
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead className="border-b border-arc-border/60 text-[10px] uppercase tracking-wider text-arc-text-muted">
                    <tr>
                        <th className="py-2 pr-3 text-left font-medium">Token</th>
                        <th className="px-3 py-2 text-right font-medium">Price</th>
                        <th className="px-3 py-2 text-right font-medium">Balance</th>
                        <th className="px-3 py-2 text-right font-medium">Value</th>
                        <th className="py-2 pl-3 text-right font-medium">Unrealized P/L</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-arc-border/40">
                    {holdings.map((h) => (
                        <TokenRow key={h.token.address} holding={h} />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function TokenRow({ holding }: { holding: HoldingInfo }) {
    const balance = holding.balance;
    const value = holding.valueUsdcRaw ?? 0n;
    const balanceFormatted = formatToken(balance, LAUNCHPAD_TOKEN_DECIMALS, 4);
    const valueFormatted = formatUSDC(value, USDC_DECIMALS, 2);
    // Price = value / balance, expressed in USD per token. The on-chain math
    // is integer-only so we compute float in display: (valueRaw / 1e6) /
    // (balance / 1e18). Skip when either side is zero.
    let priceStr = "—";
    if (balance > 0n && value > 0n) {
        const balanceFloat = Number(formatUnits(balance, LAUNCHPAD_TOKEN_DECIMALS));
        const valueFloat = Number(formatUnits(value, USDC_DECIMALS));
        if (balanceFloat > 0) {
            const price = valueFloat / balanceFloat;
            priceStr = price < 0.0001
                ? `<$0.0001`
                : `$${price.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
        }
    }
    return (
        <tr className="text-sm">
            <td className="py-3 pr-3">
                <Link
                    href={`/launchpad/${holding.token.address}`}
                    className="flex min-w-0 items-center gap-2 hover:underline"
                >
                    <TokenIcon
                        symbol={holding.token.symbol}
                        image={undefined}
                        size={28}
                    />
                    <div className="min-w-0">
                        <div className="truncate font-medium text-arc-text">
                            {holding.token.name ?? "Token"}
                        </div>
                        <div className="truncate text-[10px] text-arc-text-faint">
                            ${holding.token.symbol ?? "?"}
                        </div>
                    </div>
                </Link>
            </td>
            <td className="px-3 py-3 text-right tabular-nums text-arc-text">{priceStr}</td>
            <td className="px-3 py-3 text-right tabular-nums text-arc-text">{balanceFormatted}</td>
            <td className="px-3 py-3 text-right tabular-nums text-arc-text">
                ${valueFormatted}
            </td>
            <td className="py-3 pl-3 text-right tabular-nums text-arc-text-faint">
                — <span className="text-[10px]">(indexer)</span>
            </td>
        </tr>
    );
}

// ============================ Creator tab ============================

function CreatorTab({
    mine,
    loading,
}: {
    mine: ReturnType<typeof useLaunchpadTokens>["tokens"];
    loading: boolean;
}) {
    return (
        <div className="space-y-8">
            <CreatorEarningsCard />
            <PendingWithdrawalsCard />

            <section>
                <div className="mb-3">
                    <h2 className="text-lg font-semibold">Launched by you</h2>
                    <p className="mt-0.5 text-xs text-arc-text-muted">
                        Every token this wallet has created on the launchpad.
                    </p>
                </div>
                {loading ? (
                    <div className="arc-card p-8 text-center text-sm text-arc-text-muted">Loading…</div>
                ) : mine.length === 0 ? (
                    <div className="arc-card p-6 text-center sm:p-12">
                        <Rocket className="mx-auto mb-3 h-8 w-8 text-arc-text-faint" />
                        <p className="text-sm text-arc-text-muted">
                            You haven&apos;t launched any tokens yet.
                        </p>
                        <Link
                            href="/launchpad/create"
                            className="arc-button-primary mt-4 inline-block px-5 py-2 text-sm"
                        >
                            Launch a token
                        </Link>
                    </div>
                ) : (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {mine.map((token) => (
                            <TokenCard key={token.address} token={token} curveSupply={CURVE_SUPPLY} />
                        ))}
                    </div>
                )}
            </section>

            <section>
                <div className="mb-3">
                    <h2 className="text-lg font-semibold">Creator fees</h2>
                    <p className="mt-0.5 text-xs text-arc-text-muted">
                        Locked LP fees claimable on Clanker V3 launches you&apos;re attributed to.
                    </p>
                </div>
                <CreatorFeesPanel />
            </section>

            <section>
                <div className="mb-3">
                    <h2 className="text-lg font-semibold">Vested allocations</h2>
                    <p className="mt-0.5 text-xs text-arc-text-muted">
                        Claimable token allocations that were locked at launch.
                    </p>
                </div>
                <VaultClaimPanel />
            </section>
        </div>
    );
}

// ============================ Activity tab ============================

interface UnifiedActivityItem {
    id: string;
    kind: "bridge" | "claim" | "app";
    ts: number;
    iconSrc: string;
    type: string;
    label: string;
    value: string;
    explorerUrl?: string;
}

function ActivityTab({ account }: { account: Address }) {
    const items = useMemo(() => buildActivity(account), [account]);

    if (items.length === 0) {
        return (
            <div className="arc-card p-6 text-center sm:p-12">
                <p className="text-sm text-arc-text-muted">
                    No activity yet. Bridge, swap, or launch a token to populate this feed.
                </p>
            </div>
        );
    }

    return (
        <div className="arc-card overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="border-b border-arc-border/60 text-[10px] uppercase tracking-wider text-arc-text-muted">
                        <tr>
                            <th className="px-4 py-3 text-left font-medium">Time</th>
                            <th className="px-4 py-3 text-left font-medium">Type</th>
                            <th className="px-4 py-3 text-left font-medium">Amount</th>
                            <th className="px-4 py-3 text-left font-medium">Reference</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-arc-border/40">
                        {items.map((it) => (
                            <ActivityRowFull key={it.id} item={it} />
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="border-t border-arc-border/40 px-4 py-3 text-[10px] text-arc-text-faint">
                Local activity only — full on-chain history unlocks with the indexer.
            </div>
        </div>
    );
}

function ActivityRowFull({ item }: { item: UnifiedActivityItem }) {
    const date = new Date(item.ts).toLocaleString();
    return (
        <tr className="text-sm">
            <td className="px-4 py-3 text-xs text-arc-text-muted">{date}</td>
            <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.iconSrc} alt={item.type} className="h-5 w-5 shrink-0 object-contain" />
                    <span className="text-arc-text">{item.type}</span>
                </div>
            </td>
            <td className="px-4 py-3">
                <div className="text-arc-text-faint">{item.label}</div>
                <div className="font-medium text-arc-text">{item.value}</div>
            </td>
            <td className="px-4 py-3">
                {item.explorerUrl ? (
                    <a
                        href={item.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-arc-text-muted hover:text-arc-text"
                    >
                        View tx
                        <ExternalLink className="h-3 w-3" />
                    </a>
                ) : (
                    <span className="text-[10px] text-arc-text-faint">—</span>
                )}
            </td>
        </tr>
    );
}

// Shared Overview/Activity helpers — single-source-of-truth for merging
// the three localStorage feeds. Once Ponder is wired this collapses to a
// single GraphQL query and these adapters can be deleted.
function buildActivity(account: Address): UnifiedActivityItem[] {
    const bridges = loadBridgeHistory();
    const claims = listPendingClaims(account);
    const app = loadActivity(account);

    const items: UnifiedActivityItem[] = [
        ...bridges.map((b) => bridgeToUnified(b)),
        ...claims.map((c) => claimToUnified(c)),
        ...app.map((a) => appToUnified(a)),
    ];
    items.sort((a, b) => b.ts - a.ts);
    return items;
}

function bridgeToUnified(b: HistoryEntry): UnifiedActivityItem {
    const amountStr = (() => {
        try {
            return formatUSDC(BigInt(b.amountRaw6), 6, 2);
        } catch {
            return "?";
        }
    })();
    const label =
        b.status === "minted"
            ? "Bridge confirmed"
            : b.status === "failed"
              ? "Bridge failed"
              : "Bridge pending";
    return {
        id: `bridge-${b.id}`,
        kind: "bridge",
        ts: b.burnedAt,
        iconSrc: "/bridge.png",
        type: "Bridge",
        label,
        value: `${amountStr} USDC`,
        explorerUrl: b.burnTxHash ? `https://testnet.arcscan.app/tx/${b.burnTxHash}` : undefined,
    };
}

function claimToUnified(c: PendingTwitterClaim): UnifiedActivityItem {
    const ready = Math.floor(Date.now() / 1000) >= c.executeAfter;
    return {
        id: `claim-${c.nonce}`,
        kind: "claim",
        ts: c.savedAt * 1000,
        iconSrc: "/contract.png",
        type: "Twitter claim",
        label: ready ? "Claim ready" : "Claim authorized",
        value: `@${c.handle}`,
    };
}

function appToUnified(a: ActivityEntry): UnifiedActivityItem {
    return {
        id: `app-${a.id}`,
        kind: "app",
        ts: a.timestamp,
        iconSrc: iconForActivity(a.type),
        type: capitalize(a.type),
        label: a.label,
        value: a.value,
        explorerUrl: a.txHash ? `https://testnet.arcscan.app/tx/${a.txHash}` : undefined,
    };
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Compact list version used on the Overview tab.
function ActivityList({ account, limit }: { account: Address; limit: number }) {
    const items = useMemo(() => buildActivity(account).slice(0, limit), [account, limit]);
    if (items.length === 0) {
        return <div className="text-[11px] text-arc-text-faint">No activity yet.</div>;
    }
    return (
        <div className="space-y-3">
            {items.map((it) => (
                <div key={it.id} className="flex items-center gap-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={it.iconSrc} alt={it.type} className="h-9 w-9 shrink-0 object-contain" />
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-arc-text-faint">{it.label}</div>
                        <div className="truncate text-xs font-medium text-arc-text">{it.value}</div>
                    </div>
                    <div className="shrink-0 text-xs text-arc-text-faint">{formatAgo(it.ts)}</div>
                </div>
            ))}
        </div>
    );
}

function formatAgo(ts: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

// Suppress unused-import warnings for icons / utilities reserved for
// follow-up sections (e.g. an upcoming filters panel on Activity).
void Copy;
