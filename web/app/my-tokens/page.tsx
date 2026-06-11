"use client";

import { useAccountModal } from "@rainbow-me/rainbowkit";
import {
    ArrowLeft,
    ArrowRight,
    ArrowRightLeft,
    BarChart3,
    Calendar,
    Check,
    Coins,
    Copy,
    Download,
    ExternalLink,
    Filter,
    MoreHorizontal,
    Plus,
    Rocket,
    Search,
    Send,
    ShoppingCart,
    Wallet,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Address, erc20Abi, formatUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import dynamic from "next/dynamic";
// Audit 2026-06-11 v2 Perf P0-1: defer recharts into its own chunk via
// next/dynamic + ssr:false. The /my-tokens route was 503 kB First Load
// because the placeholder portfolio chart pulled recharts into the main
// bundle; lazy-loading it brings the route in line with the rest.
const PortfolioChart = dynamic(
    () => import("@/components/my-tokens/PortfolioChart").then((m) => m.PortfolioChart),
    { ssr: false, loading: () => <div className="h-full w-full" /> },
);
import { TokenCard } from "@/components/launchpad/TokenCard";
import { MyPositions } from "@/components/pool/MyPositions";
import { V3Positions } from "@/components/pool/V3Positions";
import { CreatorFeesPanel } from "@/components/pool/CreatorFeesPanel";
import { PendingWithdrawalsCard } from "@/components/pool/PendingWithdrawalsCard";
import { VaultClaimPanel } from "@/components/pool/VaultClaimPanel";
import { CreatePoolModal } from "@/components/pool/CreatePoolModal";
import { Modal } from "@/components/ui/Modal";
import { TokenIcon } from "@/components/ui/TokenIcon";
import type { TokenOption } from "@/components/ui/TokenSelectModal";
import { ReceiveModal } from "@/components/wallet/ReceiveModal";
import { SendModal } from "@/components/wallet/SendModal";
import { WalletIcon } from "@/components/wallet/WalletIcon";
import { ARCADE_HOOK_STATUS } from "@/lib/abis/arcadeHook";
import { ADDRESSES, LAUNCHPAD_CURVE_SUPPLY, LAUNCHPAD_GRADUATION_USDC, LAUNCHPAD_TOKEN_DECIMALS, USDC_DECIMALS, V4_HOOK_ENABLED } from "@/lib/constants";
import { useArcadeHookTokens, type ArcadeHookTokenInfo } from "@/lib/hooks/useArcadeHookTokens";
import { useLaunchpadTokens } from "@/lib/hooks/useLaunchpadTokens";
import { useMyHoldings, type HoldingInfo } from "@/lib/hooks/useMyHoldings";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { loadBridgeHistory, type HistoryEntry } from "@/lib/bridgeHistory";
import { listPendingClaims, type PendingTwitterClaim } from "@/lib/pendingClaims";
import { iconForActivity, loadActivity, type ActivityEntry } from "@/lib/activityFeed";
import { pushToast } from "@/lib/toast";
import { cn, formatAddress, formatAgo, formatToken, formatUSDC } from "@/lib/utils";

// CreatorEarningsCard pulls recharts (~80 KB gzipped) for its sparkline.
// Dynamic-import so the chart bundle only loads on /my-tokens, not on
// every page in the app's shared route bundle. ssr: false because
// recharts needs ResizeObserver.
const CreatorEarningsCard = dynamic(
  () =>
    import("@/components/pool/CreatorEarningsCard").then((m) => ({
      default: m.CreatorEarningsCard,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="h-44 w-full animate-pulse rounded-2xl border border-arc-border bg-arc-bg-elevated/50" />
    ),
  },
);

/** V4 hook holding: token info + raw balance (18 dp). No USD value yet
 *  because the curve / pool price is not exposed as a single read; deferred
 *  to the ArcLens indexer per the V4 hook frontend rollout plan. */
interface ArcadeHookHolding {
    token: ArcadeHookTokenInfo;
    balance: bigint;
}

type TabKey = "overview" | "tokens" | "positions" | "creator" | "activity";

const TABS: { key: TabKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "tokens", label: "Tokens" },
    { key: "positions", label: "Positions" },
    { key: "creator", label: "Creator" },
    { key: "activity", label: "Activity" },
];

// useSearchParams requires a Suspense boundary at the page level.
// Page default export wraps the body so the hook in MyTokensPageInner
// always has a parent boundary even on the first paint.
export default function MyTokensPage() {
    return (
        <Suspense fallback={null}>
            <MyTokensPageInner />
        </Suspense>
    );
}

function MyTokensPageInner() {
    const { address: account, connector } = useAccount();
    const { tokens, isLoading } = useLaunchpadTokens();
    const { holdings, isLoading: holdingsLoading } = useMyHoldings();
    const { tokens: v4Tokens } = useArcadeHookTokens();
    const [tab, setTab] = useState<TabKey>("overview");

    // Read ?tab=... so the header "View portfolio" link forces the user
    // back to a specific tab even when they're already on /my-tokens.
    // After applying, replace the URL without ?tab= so re-clicking the
    // same link (e.g. View portfolio while on /my-tokens?tab=overview
    // viewing Tokens tab) re-adds the param and re-fires this effect.
    // Audit UI-H-11.
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const urlTab = searchParams.get("tab");
    useEffect(() => {
        if (urlTab === "overview" || urlTab === "tokens" || urlTab === "positions" || urlTab === "creator" || urlTab === "activity") {
            setTab(urlTab as TabKey);
            router.replace(pathname, { scroll: false });
        }
    }, [urlTab, router, pathname]);

    // connector.icon is the connector-supplied logo (data URI for Backpack,
    // MetaMask, etc.). Falls back to a gradient letter circle inside
    // WalletIcon when absent.
    const walletIconSrc = (connector as { icon?: string } | undefined)?.icon;
    const walletName = connector?.name ?? "Wallet";

    const mine = useMemo(() => {
        if (!account) return [];
        const acc = account.toLowerCase();
        return tokens.filter((t) => t.creator.toLowerCase() === acc);
    }, [tokens, account]);

    // V4 launches created by this wallet. Filters useArcadeHookTokens by
    // CurveState.creator since ArcadeHook records the launcher at createLaunch
    // time and never mutates it.
    const myV4Launches = useMemo(() => {
        if (!account || !V4_HOOK_ENABLED) return [];
        const acc = account.toLowerCase();
        return v4Tokens.filter((t) => t.creator.toLowerCase() === acc);
    }, [v4Tokens, account]);

    // V4 holdings. Batch-read balanceOf(account) for every registered V4
    // token; filter out the zeros so we only show what the user actually
    // owns. Cheap on testnet (<= a few dozen V4 launches); when this gets
    // expensive the ArcLens Ponder indexer can replace the multicall.
    const v4BalanceCalls = useReadContracts({
        contracts: account
            ? v4Tokens.map((t) => ({
                  address: t.address,
                  abi: erc20Abi,
                  functionName: "balanceOf" as const,
                  args: [account] as const,
              }))
            : [],
        query: { enabled: !!account && V4_HOOK_ENABLED && v4Tokens.length > 0 },
    });
    const myV4Holdings: ArcadeHookHolding[] = useMemo(() => {
        if (!account || !v4BalanceCalls.data) return [];
        const out: ArcadeHookHolding[] = [];
        for (let i = 0; i < v4Tokens.length; i++) {
            const r = v4BalanceCalls.data[i];
            if (r?.status !== "success") continue;
            const balance = r.result as bigint;
            if (balance === 0n) continue;
            out.push({ token: v4Tokens[i], balance });
        }
        // Sort by raw balance desc as a first approximation. A USD value
        // estimate would require running the curve math per holding; defer to
        // the indexer once it exposes a per-token price.
        out.sort((a, b) => (b.balance > a.balance ? 1 : -1));
        return out;
    }, [account, v4Tokens, v4BalanceCalls.data]);

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

            <PortfolioHeader
                account={account}
                walletIconSrc={walletIconSrc}
                walletName={walletName}
            />

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
                    v4Holdings={myV4Holdings}
                />
            ) : tab === "positions" ? (
                <PositionsTab />
            ) : tab === "creator" ? (
                <CreatorTab mine={mine} v4Mine={myV4Launches} loading={isLoading} />
            ) : (
                <ActivityTab account={account} />
            )}
        </div>
    );
}

// ============================ Header ============================

function PortfolioHeader({
    account,
    walletIconSrc,
    walletName,
}: {
    account: Address | undefined;
    walletIconSrc?: string;
    walletName: string;
}) {
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
                <WalletIcon
                    icon={walletIconSrc}
                    name={account ? walletName : "?"}
                    size={40}
                    shape="full"
                />
                <div>
                    <div className="text-lg font-semibold sm:text-xl">
                        {account ? formatAddress(account) : "Not connected"}
                    </div>
                    <div className="text-xs text-arc-text-faint">My portfolio</div>
                </div>
            </div>
            <div className="flex items-center gap-2">
                {account && (
                    // Single Share button, sized ~30% larger than the previous
                    // chip (px-3 py-1.5 text-xs h-3.5 → px-4 py-2.5 text-[15px]
                    // h-[18px]). Forward icon better matches the macOS-style
                    // curved share arrow than Share2's three-node node graph.
                    <button type="button"
                        onClick={onShare}
                        className="inline-flex items-center gap-2 rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-2.5 text-[15px] font-medium text-arc-text transition-colors hover:bg-white/5"
                    >
                        <Image
                            src="/share.png"
                            alt=""
                            aria-hidden
                            width={18}
                            height={18}
                            className="h-[18px] w-[18px] object-contain"
                        />
                        Share
                    </button>
                )}
            </div>
        </div>
    );
}

// ============================ Tabs nav ============================

function PortfolioTabs({ current, onChange }: { current: TabKey; onChange: (k: TabKey) => void }) {
    return (
        // First tab flush-left with no px-4; gap-6 supplies inter-tab space.
        // Active indicator: 3px (was 2px, +30% per design) and pushed down by
        // 1px so it slightly overlaps the gray separator line instead of
        // sitting cleanly above it.
        <div className="mb-6 flex gap-6 border-b border-arc-border/60">
            {TABS.map((t) => (
                <button type="button"
                    key={t.key}
                    onClick={() => onChange(t.key)}
                    className={cn(
                        "relative py-3.5 text-base font-medium transition-colors",
                        current === t.key
                            ? "text-arc-text"
                            : "text-arc-text-muted hover:text-arc-text",
                    )}
                >
                    {t.label}
                    {current === t.key && (
                        <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-arc-cta-hover" />
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
    const { openAccountModal } = useAccountModal();
    const [receiveOpen, setReceiveOpen] = useState(false);
    const [sendOpen, setSendOpen] = useState(false);
    const [moreOpen, setMoreOpen] = useState(false);
    const [createPoolOpen, setCreatePoolOpen] = useState(false);
    const moreWrapRef = useRef<HTMLDivElement | null>(null);

    // Token list for the CreatePoolModal opened from the More dropdown.
    // Same shape as /positions/page.tsx: USDC pinned + every launchpad
    // token, deduplicated.
    const { tokens: launchpadTokensForPool } = useLaunchpadTokens();
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
        for (const t of launchpadTokensForPool) {
            const k = t.address.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({
                address: t.address,
                symbol: t.symbol,
                name: t.name,
                decimals: 18,
            });
        }
        return out;
    }, [launchpadTokensForPool]);

    // Close the More popover when the user clicks anywhere outside of it,
    // including elsewhere inside the page. Mirrors the pattern used by the
    // wallet widget's submenu.
    useEffect(() => {
        if (!moreOpen) return;
        const handler = (e: MouseEvent) => {
            if (moreWrapRef.current && !moreWrapRef.current.contains(e.target as Node)) {
                setMoreOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [moreOpen]);

    const currentUsd = Number(totalHoldingsUsd) / 1e6;
    const series = useMemo(() => generatePlaceholderSeries(currentUsd), [currentUsd]);
    // Count is shown in the Recent activity card subtitle so the user gets
    // a quick "how much have I done" signal without expanding the tab.
    const activityCount = useMemo(() => buildActivity(account).length, [account]);

    // Daily change: compare last to ~24h ago in the placeholder. Real value
    // would come from the indexer; this exists so the layout has the right
    // shape and so Realized/Total P/L compute without throwing.
    const firstY = series[0]?.y ?? currentUsd;
    const dailyDelta = currentUsd - firstY;
    const dailyPct = firstY > 0 ? (dailyDelta / firstY) * 100 : 0;
    const dailyDown = dailyDelta < 0;

    // Performance placeholders. Unrealized = "what holdings are worth now
    // minus a notional cost basis we don't have"; we surface the chart's
    // implied move as a stand-in. Realized = 0 since we don't track
    // historical trades. Total = sum. The indexer will replace this with
    // real numbers.
    const unrealized = dailyDelta;
    const realized = 0;
    const total = unrealized + realized;

    return (
        <>
            <div className="grid gap-6 lg:grid-cols-3">
                {/* Row 1 left: hero + chart (spans 2 columns) */}
                <div className="lg:col-span-2">
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
                            <PortfolioChart series={series} />
                        </div>

                        {/* Timeframe row (visual only) */}
                        <div className="mt-3 flex items-center gap-1 text-xs text-arc-text-muted">
                            {["1H", "1D", "1W", "1M", "1Y", "All"].map((label) => (
                                <button type="button"
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
                </div>

                {/* Row 1 right: 2x2 action grid + Performance card stacked.
                    Matches Uniswap portfolio's side-panel layout (Send /
                    Receive / Buy / More squares with the performance
                    breakdown below). */}
                <div className="space-y-4 lg:col-span-1">
                    <div className="grid grid-cols-2 gap-3">
                        <ActionTile
                            icon={<Send className="h-[18px] w-[18px]" />}
                            label="Send"
                            onClick={() => setSendOpen(true)}
                        />
                        <ActionTile
                            icon={<Download className="h-[18px] w-[18px]" />}
                            label="Receive"
                            onClick={() => setReceiveOpen(true)}
                        />
                        <ActionTile
                            icon={<ShoppingCart className="h-[18px] w-[18px]" />}
                            label="Buy"
                            href="/swap"
                        />
                        <div
                            ref={moreWrapRef}
                            className="relative grid"
                        >
                            <ActionTile
                                icon={<MoreHorizontal className="h-[18px] w-[18px]" />}
                                label="More"
                                onClick={() => setMoreOpen((v) => !v)}
                            />
                            {moreOpen && (
                                <div className="absolute right-0 top-full z-30 mt-1.5 w-44 overflow-hidden rounded-xl border border-arc-border bg-arc-bg-elevated shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]">
                                    <MoreMenuItem
                                        icon={<ArrowRightLeft className="h-4 w-4" />}
                                        label="Swap"
                                        href="/swap"
                                        onSelect={() => setMoreOpen(false)}
                                    />
                                    <MoreMenuItem
                                        icon={<Coins className="h-4 w-4" />}
                                        label="Sell"
                                        href="/swap"
                                        onSelect={() => setMoreOpen(false)}
                                    />
                                    <MoreMenuItem
                                        icon={<BarChart3 className="h-4 w-4" />}
                                        label="Limit"
                                        href="/swap?mode=limit"
                                        onSelect={() => setMoreOpen(false)}
                                    />
                                    <MoreMenuItem
                                        icon={<Plus className="h-4 w-4" />}
                                        label="New position"
                                        onClick={() => setCreatePoolOpen(true)}
                                        onSelect={() => setMoreOpen(false)}
                                    />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Flat (no card chrome) so it reads as a section within
                        the side panel, matching Uniswap's portfolio sidebar. */}
                    <div className="px-1 pt-1">
                        <div className="mb-3 text-sm font-semibold">Performance</div>
                        <div className="space-y-2">
                            <PerfLine label="Unrealized return" value={unrealized} pct={dailyPct} />
                            <PerfLine label="Realized return" value={realized} />
                            <PerfLine label="Total return" value={total} />
                        </div>
                    </div>
                </div>

                {/* Row 2 left: tokens preview (spans 2 columns). At the same
                    vertical level as Recent activity on the right. */}
                <div className="lg:col-span-2">
                    <div className="arc-card p-5 sm:p-6">
                        <div className="mb-3 flex items-center justify-between">
                            <div>
                                <div className="text-sm font-semibold">Tokens</div>
                                <div className="text-xs text-arc-text-faint">
                                    {holdings.length} held{launchedCount > 0 ? ` · ${launchedCount} launched` : ""}
                                </div>
                            </div>
                            <button type="button"
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

                {/* Row 2 right: recent activity */}
                <div className="lg:col-span-1">
                    <div className="arc-card p-5 sm:p-6">
                        <div className="mb-3 flex items-center justify-between">
                            <div>
                                <div className="text-sm font-semibold">Recent activity</div>
                                <div className="text-xs text-arc-text-faint">
                                    {activityCount} transaction{activityCount === 1 ? "" : "s"}
                                </div>
                            </div>
                            <button type="button"
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

            {receiveOpen && (
                <ReceiveModal address={account} onClose={() => setReceiveOpen(false)} />
            )}
            <SendModal open={sendOpen} onClose={() => setSendOpen(false)} />
            <CreatePoolModal
                open={createPoolOpen}
                onClose={() => setCreatePoolOpen(false)}
                tokens={createPoolTokens}
            />
        </>
    );
}

/**
 * Square action button used in the Overview side panel. Mirrors the wallet
 * widget's Send/Receive look so the two surfaces feel related. `href` makes
 * it a Link, otherwise it's a button with onClick.
 */
function ActionTile({
    icon,
    label,
    onClick,
    href,
    disabled,
}: {
    icon: React.ReactNode;
    label: string;
    onClick?: () => void;
    href?: string;
    disabled?: boolean;
}) {
    const className = cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-xl px-3 py-5 transition-colors",
        disabled
            ? "cursor-not-allowed bg-sky-400/5 text-sky-400/40"
            : "bg-sky-400/10 text-sky-400 hover:bg-sky-400/20",
    );
    const inner = (
        <>
            {icon}
            <span className="text-[15px] font-medium">{label}</span>
        </>
    );
    if (href && !disabled) {
        return (
            <Link href={href} className={className}>
                {inner}
            </Link>
        );
    }
    return (
        <button type="button" onClick={onClick} disabled={disabled} className={className}>
            {inner}
        </button>
    );
}

/**
 * Row in the More popover (Swap / Sell / Limit / New position). Renders as a
 * Link when an href is supplied (middle-click opens in a new tab), or as a
 * plain button when only onClick is provided - used by "New position" to
 * pop the CreatePoolModal instead of navigating away.
 */
function MoreMenuItem({
    icon,
    label,
    href,
    onClick,
    onSelect,
}: {
    icon: React.ReactNode;
    label: string;
    href?: string;
    onClick?: () => void;
    onSelect: () => void;
}) {
    const className =
        "flex items-center gap-3 px-3.5 py-2.5 text-sm text-arc-text transition-colors hover:bg-white/5";
    const inner = (
        <>
            <span className="text-arc-text-muted">{icon}</span>
            {label}
        </>
    );
    if (href) {
        return (
            <Link href={href} onClick={onSelect} className={className}>
                {inner}
            </Link>
        );
    }
    return (
        <button
            type="button"
            onClick={() => {
                onClick?.();
                onSelect();
            }}
            className={`${className} w-full text-left`}
        >
            {inner}
        </button>
    );
}

/**
 * Single-line performance row: label on the left, value on the right,
 * matching Uniswap's compact side-panel layout. `pct` adds a small
 * parenthesised percent next to the value when present.
 */
function PerfLine({ label, value, pct }: { label: string; value: number; pct?: number }) {
    const positive = value > 0;
    const negative = value < 0;
    return (
        <div className="flex items-center justify-between">
            <span className="text-xs text-arc-text-muted">{label}</span>
            <span
                className={cn(
                    "flex items-center gap-1 text-sm font-semibold tabular-nums",
                    positive ? "text-arc-success" : negative ? "text-arc-danger" : "text-arc-text",
                )}
            >
                {negative ? "▼ " : positive ? "▲ " : ""}
                ${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                {pct !== undefined && pct !== 0 && (
                    <span className="text-arc-text-muted">({pct.toFixed(2)}%)</span>
                )}
            </span>
        </div>
    );
}

// ============================ Tokens tab ============================

function TokensTab({
    holdings,
    totalHoldingsUsd,
    loading,
    v4Holdings,
}: {
    holdings: HoldingInfo[];
    totalHoldingsUsd: bigint;
    loading: boolean;
    v4Holdings: ArcadeHookHolding[];
}) {
    const hasAnything = holdings.length > 0 || v4Holdings.length > 0;
    if (loading && !hasAnything) {
        return (
            <div className="arc-card p-8 text-center text-sm text-arc-text-muted">Loading…</div>
        );
    }
    if (!hasAnything) {
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
        <div className="space-y-6">
            {holdings.length > 0 && (
                <div className="space-y-3">
                    <div className="text-xs text-arc-text-muted">
                        {holdings.length} V2/V3 token{holdings.length === 1 ? "" : "s"}
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
            )}
            {v4Holdings.length > 0 && (
                <div className="space-y-3">
                    <div className="text-xs text-arc-text-muted">
                        {v4Holdings.length} ArcadeHook (V4) token{v4Holdings.length === 1 ? "" : "s"}
                    </div>
                    <ArcadeHookHoldingsList items={v4Holdings} />
                </div>
            )}
        </div>
    );
}

function ArcadeHookCreatorCard({ token }: { token: ArcadeHookTokenInfo }) {
    const { image } = useTokenImage(token.address);
    const isGraduated = token.status === ARCADE_HOOK_STATUS.GRADUATED;
    const raisedPct = useMemo(() => {
        if (LAUNCHPAD_GRADUATION_USDC === 0n) return 0;
        const bps = (token.realUsdcReserve * 10_000n) / LAUNCHPAD_GRADUATION_USDC;
        return Math.min(100, Number(bps) / 100);
    }, [token.realUsdcReserve]);

    return (
        <Link
            href={`/launchpad/v4hook/${token.address}`}
            className="arc-card flex flex-col gap-3 p-4 transition-colors hover:border-arc-cta-hover/40"
        >
            <div className="flex items-start gap-3">
                <TokenIcon symbol={token.symbol ?? "?"} image={image} size={40} />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                        {token.name ?? "Unnamed"}{" "}
                        <span className="text-arc-text-muted">{token.symbol ?? ""}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-arc-text-faint">
                        {formatAddress(token.address)}
                    </div>
                </div>
                <span
                    className={cn(
                        "shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider",
                        isGraduated
                            ? "border-arc-success/40 bg-arc-success/10 text-arc-success"
                            : "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover",
                    )}
                >
                    {isGraduated ? "Graduated" : "Curving"}
                </span>
            </div>
            <div>
                <div className="mb-1 flex justify-between text-[10px] text-arc-text-faint">
                    <span>{raisedPct.toFixed(1)}% to graduation</span>
                    <span>
                        {(Number(token.realUsdcReserve) / 1e6).toLocaleString(undefined, {
                            maximumFractionDigits: 0,
                        })}
                        {" / 20k USDC"}
                    </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-arc-bg-elevated">
                    <div
                        className={cn(
                            "absolute left-0 top-0 h-full transition-all",
                            isGraduated
                                ? "bg-arc-success"
                                : "bg-gradient-to-r from-arc-cta to-arc-cta-hover",
                        )}
                        style={{ width: `${isGraduated ? 100 : raisedPct}%` }}
                    />
                </div>
            </div>
        </Link>
    );
}

function ArcadeHookHoldingsList({ items }: { items: ArcadeHookHolding[] }) {
    return (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((h) => (
                <ArcadeHookHoldingCard key={h.token.address} holding={h} />
            ))}
        </div>
    );
}

function ArcadeHookHoldingCard({ holding }: { holding: ArcadeHookHolding }) {
    const { image } = useTokenImage(holding.token.address);
    const isGraduated = holding.token.status === ARCADE_HOOK_STATUS.GRADUATED;
    const raisedPct = useMemo(() => {
        if (LAUNCHPAD_GRADUATION_USDC === 0n) return 0;
        const bps = (holding.token.realUsdcReserve * 10_000n) / LAUNCHPAD_GRADUATION_USDC;
        return Math.min(100, Number(bps) / 100);
    }, [holding.token.realUsdcReserve]);

    return (
        <Link
            href={`/launchpad/v4hook/${holding.token.address}`}
            className="arc-card flex flex-col gap-3 p-4 transition-colors hover:border-arc-cta-hover/40"
        >
            <div className="flex items-start gap-3">
                <TokenIcon symbol={holding.token.symbol ?? "?"} image={image} size={40} />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                        {holding.token.name ?? "Unnamed"}{" "}
                        <span className="text-arc-text-muted">{holding.token.symbol ?? ""}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-arc-text-faint">
                        {formatToken(holding.balance, LAUNCHPAD_TOKEN_DECIMALS, 2)} held
                    </div>
                </div>
                <span
                    className={cn(
                        "shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider",
                        isGraduated
                            ? "border-arc-success/40 bg-arc-success/10 text-arc-success"
                            : "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover",
                    )}
                >
                    {isGraduated ? "Graduated" : "Curving"}
                </span>
            </div>
            <div>
                <div className="mb-1 flex justify-between text-[10px] text-arc-text-faint">
                    <span>{raisedPct.toFixed(1)}% to graduation</span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-arc-bg-elevated">
                    <div
                        className={cn(
                            "absolute left-0 top-0 h-full transition-all",
                            isGraduated
                                ? "bg-arc-success"
                                : "bg-gradient-to-r from-arc-cta to-arc-cta-hover",
                        )}
                        style={{ width: `${isGraduated ? 100 : raisedPct}%` }}
                    />
                </div>
            </div>
        </Link>
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
        // Negative side margins pull the table flush with the card so the
        // per-row hover background can extend past the inner padding (matches
        // Uniswap's portfolio table where the hover bar reaches the card edge).
        // Header cells share a subtle bg-white/[0.04] pill (rounded on first
        // and last cells only) so the column labels read as a unified row.
        <div className="-mx-3 overflow-x-auto sm:-mx-4">
            <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-arc-text-muted">
                    <tr>
                        <th className="rounded-l-xl bg-white/[0.04] px-3 py-3 text-left font-medium sm:px-4">Token</th>
                        <th className="bg-white/[0.04] px-3 py-3 text-right font-medium">Price</th>
                        <th className="bg-white/[0.04] px-3 py-3 text-right font-medium">Balance</th>
                        <th className="bg-white/[0.04] px-3 py-3 text-right font-medium">Value</th>
                        <th className="rounded-r-xl bg-white/[0.04] px-3 py-3 text-right font-medium sm:px-4">Unrealized P/L</th>
                    </tr>
                </thead>
                <tbody>
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
    // Resolves the token's metadata image (ipfs:// JSON  raw image). The
    // hook caches by URI so multiple rows + the wallet widget don't refetch.
    const { image } = useTokenImage(holding.token.address);
    // Price = value / balance, expressed in USD per token. The on-chain math
    // is integer-only so we compute float in display: (valueRaw / 1e6) /
    // (balance / 1e18). Skip when either side is zero.
    let priceStr = "-";
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
        <tr className="rounded-lg text-sm transition-colors hover:bg-white/[0.04]">
            <td className="px-3 py-3 sm:px-4">
                <Link
                    href={`/launchpad/${holding.token.address}`}
                    className="flex min-w-0 items-center gap-2 hover:underline"
                >
                    <TokenIcon
                        symbol={holding.token.symbol}
                        image={image}
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
            <td className="px-3 py-3 text-right tabular-nums text-arc-text-faint sm:px-4">
                <span className="text-[10px]">(indexer)</span>
            </td>
        </tr>
    );
}

// ============================ Positions tab ============================

/**
 * LP positions surface: stacks Standard AMM (V2) on top of Concentrated
 * Liquidity (V3) so the user sees everything liquidity-side in one view.
 * Both subcomponents render nothing when the user has zero positions of
 * that kind, so the tab also self-hides each empty section.
 *
 * Burned positions (V2 LP burned by the protocol) are surfaced too - the
 * /positions page exposes them under a tab; here they're inlined at the
 * bottom because there's no tab affordance.
 */
function PositionsTab() {
    return (
        <div className="space-y-6">
            <div>
                <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-arc-text">Standard AMM</h3>
                    <Link
                        href="/positions"
                        className="rounded-lg bg-arc-cta px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                    >
                        Open positions page
                    </Link>
                </div>
                <MyPositions
                    emptyState={
                        <div className="arc-card p-6 text-center text-sm text-arc-text-muted">
                            No V2 LP positions yet.
                        </div>
                    }
                />
            </div>
            <div>
                <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-arc-text">Concentrated Liquidity</h3>
                </div>
                <V3Positions
                    emptyState={
                        <div className="arc-card p-6 text-center text-sm text-arc-text-muted">
                            No V3 positions yet.
                        </div>
                    }
                />
            </div>
        </div>
    );
}

// ============================ Creator tab ============================

function CreatorTab({
    mine,
    v4Mine,
    loading,
}: {
    mine: ReturnType<typeof useLaunchpadTokens>["tokens"];
    v4Mine: ArcadeHookTokenInfo[];
    loading: boolean;
}) {
    const hasAnyLaunch = mine.length > 0 || v4Mine.length > 0;
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
                {loading && !hasAnyLaunch ? (
                    <div className="arc-card p-8 text-center text-sm text-arc-text-muted">Loading…</div>
                ) : !hasAnyLaunch ? (
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
                    <>
                        {mine.length > 0 && (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {mine.map((token) => (
                                    <TokenCard
                                        key={token.address}
                                        token={token}
                                        curveSupply={LAUNCHPAD_CURVE_SUPPLY}
                                    />
                                ))}
                            </div>
                        )}
                        {v4Mine.length > 0 && (
                            <div className={mine.length > 0 ? "mt-6" : ""}>
                                <div className="mb-3 text-xs uppercase tracking-wider text-arc-text-faint">
                                    On the V4 hook ({v4Mine.length})
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                    {v4Mine.map((t) => (
                                        <ArcadeHookCreatorCard key={t.address} token={t} />
                                    ))}
                                </div>
                            </div>
                        )}
                    </>
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
    /** Counterparty address shown in the Address column. For sends/burns this
     *  is the recipient; for claims/receives it's the source. Truncated for
     *  display; hover reveals the per-wallet popover. */
    counterparty?: string;
    counterpartyDirection?: "to" | "from";
    /** Tx hash for the transaction-details popover (Network cost +
     *  Submitted on + explorer link). */
    txHash?: string;
    /** Drives what the Address column renders:
     *  - "to-from"      : "TO" / "FROM" caption + counterparty short (default)
     *  - "address-only" : counterparty short only, no caption (mints, claims,
     *                     fee claims - the action is self-explanatory)
     *  - "transaction"  : "TRANSACTION" caption + short txHash (swaps - the
     *                     swap counterparty is the AMM pool which is noise) */
    addressColumnKind?: "to-from" | "address-only" | "transaction";
}

type ActivityTypeFilter =
    | "all"
    | "swaps"
    | "sends"
    | "receives"
    | "wraps"
    | "withdrawals"
    | "approvals"
    | "pools-created"
    | "added-liquidity"
    | "removed-liquidity"
    | "claimed-fees"
    | "mints";

type ActivityTimeFilter = "all" | "24h" | "7d" | "30d";

const TYPE_OPTIONS: { value: ActivityTypeFilter; label: string }[] = [
    { value: "all", label: "All types" },
    { value: "swaps", label: "Swaps" },
    { value: "sends", label: "Sends" },
    { value: "receives", label: "Receives" },
    { value: "wraps", label: "Wraps" },
    { value: "withdrawals", label: "Withdrawals" },
    { value: "approvals", label: "Approvals" },
    { value: "pools-created", label: "Pools created" },
    { value: "added-liquidity", label: "Added liquidity" },
    { value: "removed-liquidity", label: "Removed liquidity" },
    { value: "claimed-fees", label: "Claimed fees" },
    { value: "mints", label: "Mints" },
];

const TIME_OPTIONS: { value: ActivityTimeFilter; label: string }[] = [
    { value: "all", label: "All time" },
    { value: "24h", label: "24 hours" },
    { value: "7d", label: "7 days" },
    { value: "30d", label: "30 days" },
];

/**
 * Maps Uniswap's category vocabulary onto the in-app activity feed. Many
 * Uniswap categories (Wraps, Approvals, Added/Removed liquidity, etc.) have
 * no equivalent on-chain action we track client-side yet, so they currently
 * return zero matches; the Ponder indexer will fill them in.
 */
function matchesActivityType(item: UnifiedActivityItem, filter: ActivityTypeFilter): boolean {
    if (filter === "all") return true;
    const t = item.type.toLowerCase();
    switch (filter) {
        case "swaps":
            return item.kind === "app" && ["buy", "sell", "swap", "multiswap"].includes(t);
        case "receives":
            return item.kind === "bridge";
        case "pools-created":
        case "mints":
            return item.kind === "app" && t === "launch";
        case "claimed-fees":
            return item.kind === "claim" || (item.kind === "app" && t === "claim-fees");
        default:
            return false;
    }
}

function matchesActivityTime(item: UnifiedActivityItem, filter: ActivityTimeFilter): boolean {
    if (filter === "all") return true;
    const windows: Record<Exclude<ActivityTimeFilter, "all">, number> = {
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000,
    };
    return item.ts >= Date.now() - windows[filter];
}

function matchesActivitySearch(item: UnifiedActivityItem, search: string): boolean {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
        item.type.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.value.toLowerCase().includes(q)
    );
}

function ActivityTab({ account }: { account: Address }) {
    const [typeFilter, setTypeFilter] = useState<ActivityTypeFilter>("all");
    const [timeFilter, setTimeFilter] = useState<ActivityTimeFilter>("all");
    const [search, setSearch] = useState("");

    const allItems = useMemo(() => buildActivity(account), [account]);
    const items = useMemo(
        () =>
            allItems.filter(
                (it) =>
                    matchesActivityType(it, typeFilter) &&
                    matchesActivityTime(it, timeFilter) &&
                    matchesActivitySearch(it, search),
            ),
        [allItems, typeFilter, timeFilter, search],
    );

    const typeLabel = TYPE_OPTIONS.find((o) => o.value === typeFilter)?.label ?? "All types";
    const timeLabel = TIME_OPTIONS.find((o) => o.value === timeFilter)?.label ?? "All time";

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <FilterMenu
                    icon={<Filter className="h-3.5 w-3.5" />}
                    label={typeLabel}
                    options={TYPE_OPTIONS}
                    value={typeFilter}
                    onChange={(v) => setTypeFilter(v as ActivityTypeFilter)}
                />
                <FilterMenu
                    icon={<Calendar className="h-3.5 w-3.5" />}
                    label={timeLabel}
                    options={TIME_OPTIONS}
                    value={timeFilter}
                    onChange={(v) => setTimeFilter(v as ActivityTimeFilter)}
                />
                <div className="ml-auto flex h-10 w-full items-center gap-2 rounded-xl border border-arc-border bg-black/15 px-3.5 backdrop-blur-xl sm:w-80">
                    <Search className="h-4 w-4 shrink-0 text-arc-text-faint" />
                    <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search activity"
                        className="w-full bg-transparent text-sm text-arc-text placeholder:text-arc-text-faint focus:outline-none"
                        aria-label="Search activity"
                    />
                </div>
            </div>

            {items.length === 0 ? (
                <div className="arc-card p-6 text-center sm:p-12">
                    <p className="text-sm text-arc-text-muted">
                        {allItems.length === 0
                            ? "No activity yet. Bridge, swap, or launch a token to populate this feed."
                            : "No activity matches the current filters."}
                    </p>
                </div>
            ) : (
                <div className="arc-card overflow-visible">
                    <div>
                        <table className="w-full text-sm">
                            <thead className="text-[11px] uppercase tracking-wider text-arc-text-muted">
                                <tr>
                                    <th className="w-[210px] rounded-l-xl bg-white/[0.04] px-4 py-3.5 text-left font-medium">Time</th>
                                    <th className="w-[180px] bg-white/[0.04] px-3 py-3.5 text-left font-medium">Type</th>
                                    <th className="w-[280px] bg-white/[0.04] px-3 py-3.5 text-left font-medium">Amount</th>
                                    <th className="bg-white/[0.04] px-3 py-3.5 text-left font-medium">Address</th>
                                    <th className="w-8 rounded-r-xl bg-white/[0.04] px-2 py-3.5" aria-label="Details" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-arc-border/25">
                                {items.map((it) => (
                                    <ActivityRowFull key={it.id} item={it} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="border-t border-arc-border/40 px-4 py-3 text-[10px] text-arc-text-faint">
                        Local activity only. Full on-chain history unlocks with the indexer.
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Compact pill-shaped filter trigger with a popover menu. Click-outside
 * closes the menu. Used for the Type and Time filters on the Activity tab.
 */
function FilterMenu({
    icon,
    label,
    options,
    value,
    onChange,
}: {
    icon: React.ReactNode;
    label: string;
    options: { value: string; label: string }[];
    value: string;
    onChange: (v: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDocClick);
        return () => document.removeEventListener("mousedown", onDocClick);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition-colors",
                    open
                        ? "border-arc-cta-hover/50 bg-arc-bg-elevated text-arc-text"
                        : "border-arc-border bg-arc-bg-elevated text-arc-text hover:border-arc-cta-hover/40",
                )}
            >
                <span className="text-arc-text-faint">{icon}</span>
                {label}
                <span className={cn("text-arc-text-faint transition-transform", open && "rotate-180")}>▾</span>
            </button>
            {open && (
                <div className="absolute left-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-xl border border-arc-border bg-arc-bg-elevated shadow-arc-card">
                    {options.map((opt) => (
                        <button type="button"
                            key={opt.value}
                            onClick={() => {
                                onChange(opt.value);
                                setOpen(false);
                            }}
                            className={cn(
                                "flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-white/5",
                                opt.value === value ? "text-arc-text" : "text-arc-text-muted",
                            )}
                        >
                            <span>{opt.label}</span>
                            {opt.value === value && <Check className="h-3 w-3 text-arc-cta-hover" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Map an epoch-ms timestamp to "Jun 1" / "Today" for the table cell, with
 *  a full "Mon Jun 1, 2026 12:00" string for the title attribute (browser
 *  tooltip on hover). Matches Uniswap's compact-day formatting. */
function formatActivityDay(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatActivityFull(ts: number): string {
    const d = new Date(ts);
    // Build manually so we can omit the comma between weekday and month
    // (toLocaleDateString with weekday + month always prints "Mon, Jun 8"
    // and the spec doesn't expose a knob to drop that separator).
    const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
    const monthDay = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const year = d.getFullYear();
    const time = d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    return `${weekday} ${monthDay}, ${year} ${time}`;
}

function ActivityRowFull({ item }: { item: UnifiedActivityItem }) {
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [addressOpen, setAddressOpen] = useState(false);
    const addressWrapRef = useRef<HTMLDivElement | null>(null);

    // Close the address popover when the user moves the mouse out of the
    // address cell. delay so brief mouse jitter doesn't kill the popover
    // mid-read.
    const closeAddressTimer = useRef<number | null>(null);
    const onAddressEnter = () => {
        if (closeAddressTimer.current) {
            window.clearTimeout(closeAddressTimer.current);
            closeAddressTimer.current = null;
        }
        setAddressOpen(true);
    };
    const onAddressLeave = () => {
        closeAddressTimer.current = window.setTimeout(() => setAddressOpen(false), 120);
    };

    const shortCounter = item.counterparty
        ? `${item.counterparty.slice(0, 6)}...${item.counterparty.slice(-4)}`
        : null;

    return (
        <tr className="group text-sm transition-colors hover:bg-white/[0.02]">
            <td className="whitespace-nowrap px-4 py-3.5 text-sm text-arc-text-muted">
                <span className="group-hover:hidden">{formatActivityDay(item.ts)}</span>
                <span className="hidden group-hover:inline">{formatActivityFull(item.ts)}</span>
            </td>
            <td className="px-3 py-3.5">
                <div className="flex items-center gap-2.5">
                    <Image
                        src={item.iconSrc}
                        alt={item.type}
                        width={22}
                        height={22}
                        className="h-[22px] w-[22px] shrink-0 object-contain"
                        unoptimized
                    />
                    <span className="text-base text-arc-text">{item.type}</span>
                </div>
            </td>
            <td className="px-3 py-3.5">
                <AmountCell value={item.value} />
            </td>
            <td className="px-3 py-3.5">
                {item.addressColumnKind === "transaction" && item.txHash ? (
                    <button
                        type="button"
                        onClick={() => setDetailsOpen(true)}
                        className="flex flex-col text-left transition-colors hover:text-arc-cta-hover"
                    >
                        <span className="text-[11px] uppercase tracking-wider text-arc-text-faint">
                            Transaction
                        </span>
                        <span className="text-sm font-medium text-arc-text">
                            {`${item.txHash.slice(0, 6)}...${item.txHash.slice(-4)}`}
                        </span>
                    </button>
                ) : item.counterparty && shortCounter ? (
                    <div
                        ref={addressWrapRef}
                        className="relative inline-block"
                        onMouseEnter={onAddressEnter}
                        onMouseLeave={onAddressLeave}
                    >
                        <div className="flex flex-col">
                            {item.counterpartyDirection && item.addressColumnKind !== "address-only" && (
                                <span className="text-[11px] uppercase tracking-wider text-arc-text-faint">
                                    {item.counterpartyDirection === "to" ? "To" : "From"}
                                </span>
                            )}
                            <span className="cursor-default text-sm font-medium text-arc-text">
                                {shortCounter}
                            </span>
                        </div>
                        {addressOpen && (
                            <AddressPopover
                                address={item.counterparty}
                                shortAddress={shortCounter}
                            />
                        )}
                    </div>
                ) : (
                    <span className="text-[10px] text-arc-text-faint">·</span>
                )}
            </td>
            <td className="w-8 px-2 py-3">
                {/* Hover-revealed arrow trigger for the per-row details popover.
                    Opacity-0 by default; the group-hover on <tr> reveals it. */}
                {(item.txHash || item.explorerUrl) && (
                    <button
                        type="button"
                        onClick={() => setDetailsOpen(true)}
                        className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-arc-text-faint opacity-0 transition-all hover:bg-white/5 hover:text-arc-text group-hover:opacity-100"
                        aria-label="Show details"
                    >
                        <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                )}
                {detailsOpen && (
                    <TransactionDetailsModal
                        item={item}
                        onClose={() => setDetailsOpen(false)}
                    />
                )}
            </td>
        </tr>
    );
}

/** Amount column rendering. Parses simple "amount ticker" strings (e.g.
 *  "1.00 USDC", "246.789508 ETH") into a logo + two-line layout matching
 *  the Uniswap reference: amount + ticker on top, USD value below.
 *  Falls back to plain text when the value isn't a single-token amount
 *  (e.g. add-liquidity "100 USDC + 25000 ETH", a ticker-only "$PUMP",
 *  or an empty action). USD only resolves for USDC since that's the
 *  only token we have a known 1:1 fiat peg for client-side; everything
 *  else hides the USD line until the indexer ships prices. */
function AmountCell({ value }: { value: string }) {
    // Tighter "amount ticker" parse than the first cut: integer part
    // either bare digits or comma-grouped thousand triplets, optional
    // fractional part, optional leading minus for refunds, ticker is a
    // pure alphanumeric word (no $ tail to avoid eating "USDC$ " into
    // the ticker capture - audit finding UI-6).
    const amountMatch = value.match(
        /^(-?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?)\s+\$?([A-Za-z][A-Za-z0-9]*)$/,
    );
    // Then "$TICKER" only (Launch $PUMP, Launch $CA).
    const tickerOnlyMatch = !amountMatch && value.match(/^\$([A-Za-z][A-Za-z0-9]*)$/);

    const ticker = amountMatch
        ? amountMatch[2]
        : tickerOnlyMatch
          ? tickerOnlyMatch[1]
          : undefined;

    const amountStr = amountMatch ? amountMatch[1] : undefined;
    const amountNum = amountStr ? Number(amountStr.replace(/,/g, "")) : undefined;
    const isUsdc = ticker?.toUpperCase() === "USDC";
    const usdValue =
        isUsdc &&
        amountNum !== undefined &&
        Number.isFinite(amountNum)
            ? amountNum.toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
              })
            : undefined;

    // Always reserve the 32px logo column so rows without a parseable
    // single-token amount (e.g. Add-liquidity "100 USDC + 25000 ETH")
    // keep the same height as rows with a logo. When no ticker is
    // detected the slot is transparent.
    return (
        <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center">
                {ticker && <TokenIcon symbol={ticker} size={32} />}
            </div>
            <div className="flex min-w-0 flex-col">
                <span className="truncate text-base font-medium text-arc-text">
                    {amountStr ? `${amountStr} ${ticker}` : value}
                </span>
                {usdValue && (
                    <span className="text-sm text-arc-text-faint">{usdValue}</span>
                )}
            </div>
        </div>
    );
}

/** Hover popover anchored under the counterparty address. Mirrors Uniswap's
 *  hover card: the address chip again (with copy + a chart-trend icon), then
 *  Balance and 1D change rows. Balance is a placeholder until the indexer
 *  ships - we can't cheaply derive arbitrary-wallet portfolio value
 *  on-chain from the client. */
function AddressPopover({
    address,
    shortAddress,
}: {
    address: string;
    shortAddress: string;
}) {
    const [copied, setCopied] = useState(false);
    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1000);
        } catch {
            /* ignore */
        }
    };
    return (
        <div className="absolute left-0 top-full z-40 mt-2 w-[19.2rem] overflow-hidden rounded-2xl border border-arc-border bg-arc-bg-elevated p-3.5 shadow-[0_18px_36px_-12px_rgba(0,0,0,0.65)]">
            <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-arc-cta-hover/30 text-arc-cta-hover">
                    <Wallet className="h-4 w-4" />
                </div>
                <span className="flex-1 truncate text-base font-semibold text-arc-text">
                    {shortAddress}
                </span>
                <button
                    type="button"
                    onClick={onCopy}
                    className="text-arc-text-faint transition-colors hover:text-arc-text"
                    aria-label="Copy address"
                    title="Copy"
                >
                    {copied ? (
                        <Check className="h-4 w-4 animate-copy-pop text-arc-success" />
                    ) : (
                        <Copy className="h-4 w-4" />
                    )}
                </button>
                <a
                    href={`https://testnet.arcscan.app/address/${address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 transition-opacity hover:opacity-80"
                    style={{
                        display: "inline-block",
                        width: 20,
                        height: 20,
                        backgroundImage: "url('/arcscan.png')",
                        backgroundSize: "contain",
                        backgroundRepeat: "no-repeat",
                        backgroundPosition: "center",
                    }}
                    aria-label="View on Arcscan"
                    title="View on Arcscan"
                />
            </div>
            <div className="my-3 border-t border-arc-border/40" />
            <div className="flex items-center justify-between text-sm">
                <span className="text-arc-text-faint">Balance</span>
                <span className="font-medium text-arc-text-muted">—</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-sm">
                <span className="text-arc-text-faint">1D change</span>
                <span className="font-medium text-arc-text-muted">—</span>
            </div>
        </div>
    );
}

/** Per-row transaction details popover, shown when the user clicks the
 *  hover-revealed arrow. Compact: status header, network cost (when
 *  available, otherwise dashes), tx hash linked to the explorer, the
 *  submitted-at timestamp, and a Close button. Mirrors Uniswap's
 *  Transaction confirmed popover. */
function TransactionDetailsModal({
    item,
    onClose,
}: {
    item: UnifiedActivityItem;
    onClose: () => void;
}) {
    const shortHash = item.txHash
        ? `${item.txHash.slice(0, 6)}...${item.txHash.slice(-4)}`
        : "—";
    const headerLabel =
        item.kind === "claim"
            ? "Claim confirmed"
            : item.kind === "bridge"
              ? "Bridge confirmed"
              : "Transaction confirmed";
    return (
        <Modal
            open
            onClose={onClose}
            widthClassName="max-w-[400px]"
            backdropClassName="backdrop:bg-black/60"
            className="border-arc-border bg-arc-bg-elevated"
        >
            <div className="p-5">
                <div className="flex items-start gap-3">
                    <Image
                        src={item.iconSrc}
                        alt=""
                        width={28}
                        height={28}
                        className="h-7 w-7 shrink-0 object-contain"
                        unoptimized
                    />
                    <div className="flex-1">
                        <div className="text-base font-semibold text-arc-text">
                            {headerLabel}
                        </div>
                        <div className="text-xs text-arc-text-faint">
                            {formatActivityFull(item.ts)}
                        </div>
                    </div>
                </div>
                <div className="my-4 border-t border-arc-border/40" />
                <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                        <span className="text-arc-text-faint">Network cost</span>
                        <span className="text-arc-text">—</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-arc-text-faint">Transaction</span>
                        {item.explorerUrl ? (
                            <a
                                href={item.explorerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 font-mono text-xs text-arc-text hover:text-arc-cta-hover"
                            >
                                {shortHash}
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        ) : (
                            <span className="font-mono text-xs text-arc-text-muted">{shortHash}</span>
                        )}
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-arc-text-faint">Submitted on</span>
                        <span className="text-xs text-arc-text">{formatActivityFull(item.ts)}</span>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="mt-5 w-full rounded-xl bg-arc-cta px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-arc-cta-hover"
                >
                    Close
                </button>
            </div>
        </Modal>
    );
}

// Shared Overview/Activity helpers, single source of truth for merging
// the three localStorage feeds. Once Ponder is wired this collapses to a
// single GraphQL query and these adapters can be deleted.
function buildActivity(account: Address): UnifiedActivityItem[] {
    const bridges = loadBridgeHistory(account);
    const claims = listPendingClaims(account);
    const app = loadActivity(account);

    // bridges fan out: every entry produces the Bridge (burn) row, and any
    // entry whose attestation landed AND was minted on the dst chain also
    // produces a sibling Claim row. flatMap keeps both on a single timeline.
    const items: UnifiedActivityItem[] = [
        ...bridges.flatMap((b) => bridgeToUnified(b)),
        ...claims.map((c) => claimToUnified(c)),
        ...app.map((a) => appToUnified(a)),
    ];
    items.sort((a, b) => b.ts - a.ts);
    return items;
}

function bridgeToUnified(b: HistoryEntry): UnifiedActivityItem[] {
    const amountStr = (() => {
        try {
            return formatUSDC(BigInt(b.amountRaw6), 6, 2);
        } catch {
            return "?";
        }
    })();
    const burnLabel =
        b.status === "minted"
            ? "Bridge sent"
            : b.status === "failed"
              ? "Bridge failed"
              : "Bridge pending";
    const out: UnifiedActivityItem[] = [
        {
            // Prefix with burnTxHash (guaranteed unique per bridge) to
            // defend against HistoryEntry.id collisions if the
            // localStorage migration ever produces duplicates. Audit
            // UI-H-5.
            id: `bridge-${b.burnTxHash}-${b.id}`,
            kind: "bridge",
            ts: b.burnedAt,
            iconSrc: "/bridge.png",
            type: "Bridge",
            label: burnLabel,
            value: `${amountStr} USDC`,
            counterparty: b.recipient,
            counterpartyDirection: "to",
            txHash: b.burnTxHash,
            explorerUrl: b.burnTxHash ? `https://testnet.arcscan.app/tx/${b.burnTxHash}` : undefined,
        },
    ];
    // Minted bridge = a second on-chain action (the dst-chain mint) the user
    // actually received. Surface it as its own Claim row with the contract
    // glyph; ts = mintedAt so it sorts after the burn row in the timeline.
    if (b.status === "minted" && b.mintedAt) {
        out.push({
            id: `bridge-${b.burnTxHash}-${b.id}-claim`,
            kind: "claim",
            ts: b.mintedAt,
            iconSrc: "/contract.png",
            type: "Claim",
            label: "Bridge claimed",
            value: `${amountStr} USDC`,
            counterparty: b.recipient,
            counterpartyDirection: "to",
            // Mint side of a bridge is a self-action ("you claimed for
            // yourself") - drop the TO/FROM caption since it's redundant.
            addressColumnKind: "address-only",
            txHash: b.mintTxHash,
            explorerUrl: b.mintTxHash ? `https://testnet.arcscan.app/tx/${b.mintTxHash}` : undefined,
        });
    }
    return out;
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
    // Swaps don't have a meaningful counterparty (it's an AMM pool); show
    // the tx hash instead. Mints, claims, and fee claims are self-actions;
    // drop the TO/FROM caption since it's noise. Sends always show the
    // recipient address (counterparty) as TO. Everything else falls back
    // to the standard counterparty rendering.
    const swapTypes = new Set(["swap", "buy", "sell", "multiswap"]);
    const selfActionTypes = new Set(["launch", "claim-fees", "add-liquidity"]);
    const addressColumnKind: UnifiedActivityItem["addressColumnKind"] =
        a.type === "send"
            ? "to-from"
            : swapTypes.has(a.type)
              ? "transaction"
              : selfActionTypes.has(a.type)
                ? "address-only"
                : "to-from";
    return {
        id: `app-${a.id}`,
        kind: "app",
        ts: a.timestamp,
        iconSrc: iconForActivity(a.type),
        type: capitalize(a.type),
        label: a.label,
        value: a.value,
        addressColumnKind,
        // Send entries carry the recipient as the activity row's token
        // address (we hijack the field since ActivityEntry doesn't have
        // a dedicated counterparty). The Send modal sets a.token = recipient.
        counterparty: a.type === "send" ? a.token : undefined,
        counterpartyDirection: a.type === "send" ? "to" : undefined,
        txHash: a.txHash,
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
                    <Image src={it.iconSrc} alt={it.type} width={36} height={36} className="h-9 w-9 shrink-0 object-contain" unoptimized />
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

// formatAgo lives in @/lib/utils.

