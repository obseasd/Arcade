"use client";

import { X } from "lucide-react";
import { RefreshIcon } from "@/components/ui/MaskIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Address } from "viem";
import { usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { ORBS_TWAP_ABI, decodeOrderStatus } from "@/lib/abis/orbsTwap";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { pushToast } from "@/lib/toast";
import { cn, formatToken } from "@/lib/utils";

interface Props {
    account: Address;
    /** Visual styling: card chrome (inline mobile) vs glassy (floating desktop). */
    variant?: "card" | "floating";
    className?: string;
}

type OrderTuple = {
    id: bigint;
    status: number;
    time: number;
    filledTime: number;
    srcFilledAmount: bigint;
    maker: Address;
    ask: {
        exchange: Address;
        srcToken: Address;
        dstToken: Address;
        srcAmount: bigint;
        srcBidAmount: bigint;
        dstMinAmount: bigint;
        deadline: number;
        bidDelay: number;
        fillDelay: number;
        data: `0x${string}`;
    };
    /** Keeper bid currently parked on this order. `time === 0` means no
     *  bid exists; otherwise a keeper has committed at `time` and the
     *  fill window opens at `time + ask.bidDelay`. Used by the "in
     *  motion" badge so the maker can tell a keeper is engaged. */
    bid: {
        time: number;
        taker: Address;
        exchange: Address;
        dstAmount: bigint;
        dstFee: bigint;
        data: `0x${string}`;
    };
    /** Set by the ?devFakeBid URL flag so the badge can render a "DEV"
     *  prefix and the maker doesn't mistake the synthetic bid for a
     *  real keeper engagement. Not present on real orders. */
    __devFake?: boolean;
};

/**
 * Open Orders + Order History panel for limit orders. Reads the on-chain
 * order book directly via twap.orderIdsByMaker(account) and batched
 * useReadContracts for each order. No backend.
 *
 * Layout (per design):
 *   - Header row: tabs on the left, Refresh as an icon button on the right.
 *   - Body: list of orders matching the active tab, or empty-state copy.
 *   - Footer: Cancel All button anchored bottom-right, ONLY when the Open
 *     Orders tab is active AND there are open orders to cancel.
 *
 * Used twice on /swap when the Limit tab is active:
 *   - Inline below the card on mobile (variant="card").
 *   - Floating top-right on desktop (variant="floating").
 * Both instances share the underlying wagmi query cache.
 */
export function LimitOrdersPanel({ account, variant = "card", className }: Props) {
    const { tokens: v2Tokens } = useV2Tokens();
    const { tokens: v3Tokens } = useV3Tokens();
    const [tab, setTab] = useState<"open" | "history">("open");
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
    // Local spin state for the refresh button. We hold it true for at least
    // 600ms so the user actually sees the icon animate even when the wagmi
    // cache returns instantly. Tied to a count so consecutive clicks restart
    // the animation rather than no-op when a refetch is still in flight.
    const [refreshTick, setRefreshTick] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    // REACT-001: hold the spin-end timer on a ref so we can cancel it on
    // unmount or before queuing a new one. Without the cleanup, clicking
    // Refresh and then navigating away leaves setIsRefreshing pending on
    // an unmounted component, triggering React's "state update on
    // unmounted component" warning and a minor memory churn.
    const refreshTimer = useRef<number | null>(null);

    useEffect(() => {
        const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
        return () => clearInterval(t);
    }, []);

    // Cancel any pending refresh-spin timer on unmount.
    useEffect(() => {
        return () => {
            if (refreshTimer.current !== null) {
                window.clearTimeout(refreshTimer.current);
                refreshTimer.current = null;
            }
        };
    }, []);

    const idsQ = useReadContract({
        address: ADDRESSES.orbsTwap,
        abi: ORBS_TWAP_ABI,
        functionName: "orderIdsByMaker",
        args: [account],
        query: { refetchInterval: 15_000 },
    });
    const ids = ((idsQ.data as bigint[] | undefined) ?? []).map((b) => Number(b));

    // Batch-fetch every order in a single multicall instead of N separate
    // useReadContract instances. This is what allows us to compute the open
    // count + render the list from one source of truth.
    const ordersQ = useReadContracts({
        contracts: ids.map((id) => ({
            address: ADDRESSES.orbsTwap,
            abi: ORBS_TWAP_ABI,
            functionName: "order",
            args: [BigInt(id)],
        })),
        query: { refetchInterval: 15_000, enabled: ids.length > 0 },
    });

    // Dev-mode hook: `?devFakeBid=N` (or `?devFakeBid=first`) injects a
    // synthetic keeper bid into the first/Nth open order so the
    // "In motion · Xs" → "Ready to fill" badge renders against real
    // chain state. Useful on Arc Testnet where no keeper bot is live
    // and otherwise no bid event would ever fire. Decays out of the
    // in-motion window after ~bidDelay seconds (= 12s by Orbs default)
    // so you can watch both states without reloading.
    const searchParams = useSearchParams();
    const devFakeBidParam = searchParams?.get("devFakeBid") ?? null;

    const orders: OrderTuple[] = useMemo(() => {
        if (!ordersQ.data) return [];
        const real = ordersQ.data
            .map((r) => (r.status === "success" ? (r.result as unknown as OrderTuple) : undefined))
            .filter((o): o is OrderTuple => !!o);
        if (!devFakeBidParam) return real;
        // Match either an order id (devFakeBid=42) or position
        // ("first"). Falls back to the first OPEN order so the flag
        // does something useful even on a brand-new wallet.
        const targetIdx = (() => {
            if (devFakeBidParam === "first") {
                return real.findIndex((o) => decodeOrderStatus(o.status, now) === "open");
            }
            const asId = Number(devFakeBidParam);
            if (!Number.isFinite(asId)) {
                return real.findIndex((o) => decodeOrderStatus(o.status, now) === "open");
            }
            return real.findIndex((o) => Number(o.id) === asId);
        })();
        if (targetIdx < 0) return real;
        return real.map((o, i) => {
            if (i !== targetIdx) return o;
            return {
                ...o,
                __devFake: true,
                bid: {
                    time: now - 4, // 4s into a bidDelay window
                    taker: "0xDeadBeefCafe1234567890abCDEF000000000001" as Address,
                    exchange: o.ask.exchange,
                    dstAmount: o.ask.dstMinAmount,
                    dstFee: 0n,
                    data: "0x",
                },
            };
        });
    }, [ordersQ.data, devFakeBidParam, now]);

    const visible = useMemo(() => {
        return orders.filter((o) => {
            const state = decodeOrderStatus(o.status, now);
            return tab === "open" ? state === "open" : state !== "open";
        });
    }, [orders, tab, now]);

    const openOrders = useMemo(
        () => orders.filter((o) => decodeOrderStatus(o.status, now) === "open"),
        [orders, now],
    );

    // Resolve token metadata for any address that might show up in an order.
    // Includes both V2 pool tokens AND V3 launch tokens so single-sided
    // CLANKER_V3 tokens (e.g. OBS) render with their symbol and icon instead
    // of falling back to "?". USDC is pinned for the gas/quote asset.
    const tokenMap = useMemo(() => {
        const m = new Map<string, { symbol: string; decimals: number }>();
        m.set(ADDRESSES.usdc.toLowerCase(), { symbol: "USDC", decimals: USDC_DECIMALS });
        // 2026-06-15 audit MEDIUM fix: literal `decimals: 18` discarded the
        // real on-chain decimals that useV2Tokens / useV3Tokens already
        // fetch. cirBTC (8 decimals) and EURC (6 decimals) limit orders
        // rendered as `<0.0001 cirBTC` etc. - the on-chain order is
        // correct (LimitCard uses t.decimals on create), only the
        // panel's display was broken. Use the real value, fall back to
        // 18 only when the hook surfaced no decimals.
        for (const t of v2Tokens) {
            m.set(t.address.toLowerCase(), {
                symbol: t.symbol ?? "TOKEN",
                decimals: t.decimals ?? 18,
            });
        }
        for (const t of v3Tokens) {
            const k = t.address.toLowerCase();
            if (!m.has(k))
                m.set(k, {
                    symbol: t.symbol ?? "TOKEN",
                    decimals: t.decimals ?? 18,
                });
        }
        return m;
    }, [v2Tokens, v3Tokens]);

    const { writeContractAsync, isPending } = useWriteContract();
    const publicClient = usePublicClient();

    const onCancelAll = async () => {
        if (openOrders.length === 0) return;
        pushToast({
            kind: "info",
            title: `Cancelling ${openOrders.length} order${openOrders.length === 1 ? "" : "s"}`,
            message: "Confirm each tx in your wallet.",
        });
        // RACE-011: writeContractAsync resolves on WALLET CONFIRMATION,
        // not on mining. If a keeper fills order N+1 while the user is
        // signing the cancel for N, the next cancel will revert on-chain
        // even though we already counted it as submitted. Two fixes:
        //  - Wait for the receipt between iterations so a fill in-between
        //    surfaces as a per-order error before we move on.
        //  - Refetch the orders + ids list each loop so the final toast
        //    reads the actual on-chain remaining count.
        // Also re-word the final toast to "Submitted N cancel txs" - we
        // can confirm the user pressed Approve, not that the cancels
        // landed.
        let submitted = 0;
        for (const o of openOrders) {
            try {
                const hash = await writeContractAsync({
                    address: ADDRESSES.orbsTwap,
                    abi: ORBS_TWAP_ABI,
                    functionName: "cancel",
                    args: [o.id],
                });
                submitted++;
                // Wait for the receipt before submitting the next cancel
                // so the order book reflects what's already cancelled. If
                // the tx reverts (keeper filled in the meantime), the
                // throw lands in catch and we surface it.
                if (publicClient) {
                    await publicClient.waitForTransactionReceipt({ hash });
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : "Cancel failed";
                pushToast({
                    kind: "error",
                    title: `Cancel #${Number(o.id)} failed`,
                    message: msg.slice(0, 120),
                });
                break;
            }
        }
        if (submitted > 0) {
            pushToast({
                kind: "info",
                title: `Submitted ${submitted} cancel${submitted === 1 ? "" : "s"}`,
            });
            ordersQ.refetch();
            idsQ.refetch();
        }
    };

    const onCancelOne = async (id: bigint) => {
        try {
            await writeContractAsync({
                address: ADDRESSES.orbsTwap,
                abi: ORBS_TWAP_ABI,
                functionName: "cancel",
                args: [id],
            });
            pushToast({ kind: "info", title: `Order #${Number(id)} cancelled` });
            ordersQ.refetch();
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Cancel failed";
            pushToast({ kind: "error", title: "Cancel failed", message: msg.slice(0, 120) });
        }
    };

    const onRefreshClick = async () => {
        setRefreshTick((n) => n + 1);
        setIsRefreshing(true);
        // Cancel any in-flight spin-end timer from a previous click so
        // rapid double-clicks don't shorten the second animation.
        if (refreshTimer.current !== null) {
            window.clearTimeout(refreshTimer.current);
            refreshTimer.current = null;
        }
        try {
            await Promise.all([idsQ.refetch(), ordersQ.refetch()]);
        } finally {
            // Hold the spin for a beat so the click registers visually even
            // when wagmi resolves from cache instantly. 600ms feels snappy
            // without dragging.
            refreshTimer.current = window.setTimeout(() => {
                setIsRefreshing(false);
                refreshTimer.current = null;
            }, 600);
        }
    };

    return (
        // Both variants now share the arc-card chrome (rounded-2xl + thin
        // border + bg-black/15 + backdrop-blur-xl). Matching the LimitCard
        // pixel for pixel was the explicit UX direction.
        <div className={cn("arc-card flex flex-col p-5 sm:p-6", className)}>
            <div className="mb-4 flex items-center gap-4">
                <button type="button"
                    onClick={() => setTab("open")}
                    className={cn(
                        "text-sm font-semibold transition-colors",
                        tab === "open"
                            ? "text-arc-text"
                            : "text-arc-text-muted hover:text-arc-text",
                    )}
                >
                    Open Orders
                </button>
                <button type="button"
                    onClick={() => setTab("history")}
                    className={cn(
                        "text-sm font-semibold transition-colors",
                        tab === "history"
                            ? "text-arc-text"
                            : "text-arc-text-muted hover:text-arc-text",
                    )}
                >
                    Order History
                </button>
                <button type="button"
                    onClick={onRefreshClick}
                    title="Refresh"
                    className="ml-auto flex h-8 w-8 items-center justify-center rounded-md border border-arc-border bg-arc-bg-elevated text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text active:scale-95"
                >
                    {/* key=refreshTick forces a remount so the spin animation
                        restarts on every click, even if the previous spin is
                        still running. */}
                    <span key={refreshTick}>
                        <RefreshIcon size={14} spinning={isRefreshing} />
                    </span>
                </button>
            </div>

            <div className="min-h-[100px] flex-1">
                {ids.length === 0 || visible.length === 0 ? (
                    <div className="py-6 text-center text-xs text-arc-text-faint">
                        {tab === "open" ? "No open orders." : "No orders history."}
                    </div>
                ) : (
                    <div className="space-y-2">
                        {visible
                            .slice()
                            .reverse()
                            .map((order) => (
                                <OrderRow
                                    key={Number(order.id)}
                                    order={order}
                                    now={now}
                                    tokenMap={tokenMap}
                                    onCancel={onCancelOne}
                                    cancelling={isPending}
                                />
                            ))}
                    </div>
                )}
            </div>

            {tab === "open" && openOrders.length > 0 && (
                <div className="mt-4 flex justify-end">
                    <button type="button"
                        onClick={onCancelAll}
                        disabled={isPending}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-arc-danger/40 bg-arc-danger/10 px-3 py-1.5 text-xs font-medium text-arc-danger transition-colors hover:bg-arc-danger/20 disabled:opacity-50"
                    >
                        Cancel All
                    </button>
                </div>
            )}
        </div>
    );
}

function OrderRow({
    order,
    now,
    tokenMap,
    onCancel,
    cancelling,
}: {
    order: OrderTuple;
    now: number;
    tokenMap: Map<string, { symbol: string; decimals: number }>;
    onCancel: (id: bigint) => Promise<void>;
    cancelling: boolean;
}) {
    const state = decodeOrderStatus(order.status, now);
    const src = tokenMap.get(order.ask.srcToken.toLowerCase()) ?? { symbol: "?", decimals: 18 };
    const dst = tokenMap.get(order.ask.dstToken.toLowerCase()) ?? { symbol: "?", decimals: 18 };
    // In-motion = a keeper has placed a bid on this open order and the
    // fill window hasn't opened yet (current time < bid.time + bidDelay).
    // When the window opens, the fill can land any block, so we flip the
    // sub-state to "Ready to fill" without changing the canonical state
    // (still "open" until the on-chain status changes).
    const bidPlaced = state === "open" && order.bid.time > 0;
    const fillWindowOpensAt = order.bid.time + order.ask.bidDelay;
    const inMotion = bidPlaced && now < fillWindowOpensAt;
    const readyToFill = bidPlaced && now >= fillWindowOpensAt;
    const fillEtaSec = inMotion ? fillWindowOpensAt - now : 0;

    const filledPct =
        order.ask.srcAmount > 0n
            ? Number((order.srcFilledAmount * 1000n) / order.ask.srcAmount) / 10
            : 0;

    return (
        <div className="rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-arc-text-faint">#{Number(order.id)}</span>
                        <StatusPill state={state} />
                        {inMotion && (
                            <span
                                className="inline-flex items-center gap-1 rounded-md bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-sky-400"
                                title={`Keeper ${order.bid.taker.slice(0, 6)}…${order.bid.taker.slice(-4)} bid at block-time ${order.bid.time}. Fill window opens in ${fillEtaSec}s.${order.__devFake ? " (synthetic bid injected by ?devFakeBid URL flag)" : ""}`}
                            >
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                                {order.__devFake ? "DEV · " : ""}In motion · {fillEtaSec}s
                            </span>
                        )}
                        {readyToFill && (
                            <span
                                className="inline-flex items-center gap-1 rounded-md bg-arc-warn/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-arc-warn"
                                title={`Keeper ${order.bid.taker.slice(0, 6)}…${order.bid.taker.slice(-4)} can call fill any block.${order.__devFake ? " (synthetic bid injected by ?devFakeBid URL flag)" : ""}`}
                            >
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-arc-warn" />
                                {order.__devFake ? "DEV · " : ""}Ready to fill
                            </span>
                        )}
                    </div>
                    {/* Visual sell -> buy line with token icons. Matches the
                        chrome of TokenRow chips in the Limit card so the user
                        recognises the assets immediately. Each side is a
                        whitespace-nowrap group so the icon-amount-symbol triple
                        never breaks mid-token; the outer row wraps as a whole
                        on narrow screens. */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-arc-text">
                        <span className="flex items-center gap-1.5 whitespace-nowrap">
                            <span className="text-arc-text-muted">Sell</span>
                            <AutoTokenIcon
                                address={order.ask.srcToken}
                                symbol={src.symbol}
                                size={16}
                            />
                            <span className="font-medium tabular-nums">
                                {formatToken(order.ask.srcAmount, src.decimals, 4)}
                            </span>
                            <span>{src.symbol}</span>
                        </span>
                        <span className="flex items-center gap-1.5 whitespace-nowrap">
                            <span className="text-arc-text-muted">for</span>
                            <AutoTokenIcon
                                address={order.ask.dstToken}
                                symbol={dst.symbol}
                                size={16}
                            />
                            <span>{dst.symbol}</span>
                        </span>
                    </div>
                    <div className="mt-1 text-[11px] text-arc-text-muted tabular-nums">
                        Min:{" "}
                        <span className="text-arc-text">
                            {formatToken(order.ask.dstMinAmount, dst.decimals, 4)} {dst.symbol}
                        </span>
                    </div>
                    {filledPct > 0 && (
                        <div className="mt-1 text-[10px] text-arc-text-faint">
                            Filled: {filledPct.toFixed(1)}%
                        </div>
                    )}
                    {state === "open" && (
                        <div className="mt-1 text-[10px] text-arc-text-faint">
                            Expires in:{" "}
                            {order.ask.deadline > 0
                                ? formatExpiresIn(order.ask.deadline)
                                : "no expiry"}
                        </div>
                    )}
                </div>
                {state === "open" && (
                    <button type="button"
                        onClick={() => onCancel(order.id)}
                        disabled={cancelling}
                        title="Cancel this order on-chain"
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-arc-danger/40 bg-arc-danger/10 px-2 py-1 text-[10px] text-arc-danger transition-colors hover:bg-arc-danger/20 disabled:opacity-50"
                    >
                        <X className="h-3 w-3" />
                        Cancel
                    </button>
                )}
            </div>
        </div>
    );
}

/**
 * Pretty-print a future deadline (unix seconds) as a human-relative
 * duration. Picks the largest non-zero unit so a 30-day order reads
 * "30d", a 12-hour order reads "12h", a 5-minute order "5m". For
 * already-expired deadlines (defensive - the caller should switch the
 * row to the "expired" state instead) we return "expired".
 */
function formatExpiresIn(deadlineSec: number): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const dt = deadlineSec - nowSec;
    if (dt <= 0) return "expired";
    const days = Math.floor(dt / 86_400);
    if (days >= 1) {
        const hrs = Math.floor((dt - days * 86_400) / 3600);
        return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`;
    }
    const hours = Math.floor(dt / 3600);
    if (hours >= 1) {
        const mins = Math.floor((dt - hours * 3600) / 60);
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }
    const mins = Math.floor(dt / 60);
    return mins >= 1 ? `${mins}m` : `<1m`;
}

function StatusPill({ state }: { state: "open" | "expired" | "cancelled" | "completed" }) {
    const color =
        state === "open"
            ? "bg-arc-success/15 text-arc-success"
            : state === "completed"
              ? "bg-sky-400/15 text-sky-400"
              : state === "cancelled"
                ? "bg-arc-text-faint/15 text-arc-text-faint"
                : "bg-arc-warn/15 text-arc-warn";
    return (
        <span
            className={cn(
                "rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                color,
            )}
        >
            {state}
        </span>
    );
}
