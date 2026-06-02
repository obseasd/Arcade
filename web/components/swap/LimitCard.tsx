"use client";

import { ArrowDownUp, ChevronDown, Info, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { erc20Abi, formatUnits, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { ADDRESSES, LIMIT_ORDERS_ENABLED, USDC_DECIMALS } from "@/lib/constants";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { ORBS_TWAP_ABI, decodeOrderStatus } from "@/lib/abis/orbsTwap";
import { addActivity } from "@/lib/activityFeed";
import { pushToast } from "@/lib/toast";
import { SwapTabs, type SwapTab } from "./SwapTabs";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

const USDC_TOKEN: TokenOption = {
    address: ADDRESSES.usdc,
    symbol: "USDC",
    name: "USD Coin",
    decimals: USDC_DECIMALS,
    pinned: true,
};

const EXPIRY_PRESETS = [
    { id: "1d", label: "1 day", seconds: 24 * 60 * 60 },
    { id: "7d", label: "1 week", seconds: 7 * 24 * 60 * 60 },
    { id: "30d", label: "1 month", seconds: 30 * 24 * 60 * 60 },
    { id: "custom", label: "Custom", seconds: 0 },
] as const;

type ExpiryId = (typeof EXPIRY_PRESETS)[number]["id"];

// Per TWAP.sol require at L114: ask.bidDelay >= MIN_BID_DELAY_SECONDS (30).
// We use the floor so orders are fillable as soon as the auction can clear.
const BID_DELAY_SECONDS = 30;
// Single-chunk limit order: fillDelay between chunks does not matter because
// there is only one chunk. We set it to 0 to avoid blocking re-attempts on
// the same order after a failed fill.
const FILL_DELAY_SECONDS = 0;

interface LimitCardProps {
    tab: SwapTab;
    onTabChange: (t: SwapTab) => void;
}

/**
 * Limit order entry card backed by the on-chain Orbs TWAP / dLIMIT contract.
 *
 * Workflow (all on-chain, no off-chain order book):
 *   1. User picks src and dst tokens.
 *   2. User enters srcAmount and a trigger price (dst per src).
 *   3. UI computes dstMinAmount = srcAmount * triggerPrice, deadline = now + expiry.
 *   4. If the user has not yet approved TWAP for srcToken, an approval tx is
 *      prompted first via useApproveIfNeeded.
 *   5. User signs the ask(Ask) call. The order lands in TWAP.book[].
 *   6. Open Orders panel below reads orderIdsByMaker(account) and each order(id).
 *   7. Keepers (Orbs L3 or our own bot) bid + fill when pool price meets trigger.
 *   8. Maker can cancel at any time via twap.cancel(id) (on-chain tx).
 *
 * Critical UX gate: dstToken MUST be a real ERC20 (never zeroAddress). The
 * TWAP contract L83 require explicitly rejects `srcToken == iweth && dstToken == address(0)`
 * (the WETH-unwrap path). We additionally enforce dstToken != zeroAddress at the
 * picker layer as defense in depth on Arc where USDC, not ETH, is the native gas.
 */
export function LimitCard({ tab, onTabChange }: LimitCardProps) {
    const { address: account } = useAccount();
    const { tokens: v2Tokens } = useV2Tokens();
    const publicClient = usePublicClient();

    const [tokenIn, setTokenIn] = useState<TokenOption>(USDC_TOKEN);
    const [tokenOut, setTokenOut] = useState<TokenOption | undefined>(undefined);
    const [amountIn, setAmountIn] = useState("");
    const [triggerPrice, setTriggerPrice] = useState("");
    const [expiryId, setExpiryId] = useState<ExpiryId>("7d");
    const [customDays, setCustomDays] = useState("0");
    const [customHours, setCustomHours] = useState("0");
    const [customMinutes, setCustomMinutes] = useState("10");
    const [pickerOpen, setPickerOpen] = useState<"in" | "out" | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const tokenOptions = useMemo<TokenOption[]>(() => {
        const opts: TokenOption[] = [USDC_TOKEN];
        for (const t of v2Tokens) {
            if (t.address.toLowerCase() === ADDRESSES.usdc.toLowerCase()) continue;
            opts.push({
                address: t.address,
                symbol: t.symbol ?? "TOKEN",
                name: t.name ?? "Token",
                decimals: 18,
                pinned: false,
            });
        }
        return opts;
    }, [v2Tokens]);

    const balanceQ = useReadContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });
    const balance = (balanceQ.data as bigint | undefined) ?? 0n;

    const expirySeconds = useMemo(() => {
        if (expiryId === "custom") {
            const d = Math.max(0, parseInt(customDays || "0", 10));
            const h = Math.max(0, parseInt(customHours || "0", 10));
            const m = Math.max(0, parseInt(customMinutes || "0", 10));
            return d * 86400 + h * 3600 + m * 60;
        }
        return EXPIRY_PRESETS.find((p) => p.id === expiryId)?.seconds ?? 0;
    }, [expiryId, customDays, customHours, customMinutes]);

    // TokenOption decimals is optional in the picker's type. Default to 18 for
    // launchpad tokens and to USDC_DECIMALS for USDC. This is also what the
    // legacy SwapCard uses.
    const inDec = tokenIn.decimals ?? 18;
    const outDec = tokenOut?.decimals ?? 18;

    const srcAmountBn = useMemo(() => {
        try {
            if (!amountIn || Number(amountIn) <= 0) return 0n;
            return parseUnits(amountIn, inDec);
        } catch {
            return 0n;
        }
    }, [amountIn, inDec]);

    const dstMinAmountBn = useMemo(() => {
        if (!tokenOut || !triggerPrice || Number(triggerPrice) <= 0) return 0n;
        try {
            // dstMinAmount = srcAmount * triggerPrice (parsed in dst decimals).
            // We compute: floor(srcAmount * triggerPrice * 10^dstDec / 10^srcDec)
            const triggerBn = parseUnits(triggerPrice, outDec);
            return (srcAmountBn * triggerBn) / 10n ** BigInt(inDec);
        } catch {
            return 0n;
        }
    }, [tokenOut, triggerPrice, srcAmountBn, inDec, outDec]);

    const { allowance, ensureAllowance } = useApproveIfNeeded(
        tokenIn.address,
        ADDRESSES.orbsTwap,
    );
    const needsApproval = allowance < srcAmountBn;

    const { writeContractAsync, isPending: isWriting } = useWriteContract();

    const canSubmit =
        LIMIT_ORDERS_ENABLED &&
        !!account &&
        !!tokenOut &&
        tokenOut.address !== zeroAddress &&
        srcAmountBn > 0n &&
        srcAmountBn <= balance &&
        dstMinAmountBn > 0n &&
        expirySeconds > 0 &&
        ADDRESSES.orbsTwap !== zeroAddress &&
        ADDRESSES.orbsExchangeV2 !== zeroAddress &&
        !submitting &&
        !isWriting;

    const swapDirection = () => {
        if (!tokenOut) return;
        const newIn = tokenOut;
        const newOut = tokenIn;
        setTokenIn(newIn);
        setTokenOut(newOut);
        setAmountIn("");
        setTriggerPrice("");
    };

    const onSubmit = async () => {
        if (!canSubmit || !tokenOut || !account) return;
        if (tokenOut.address === zeroAddress) {
            pushToast({ kind: "error", title: "Invalid output token" });
            return;
        }

        setSubmitting(true);
        try {
            if (needsApproval) {
                await ensureAllowance(srcAmountBn);
            }

            const now = Math.floor(Date.now() / 1000);
            const deadline = now + expirySeconds;

            // Ask struct mirrors contracts/orbs/src/OrderLib.sol.Ask exactly.
            // For a single-chunk limit order we set srcBidAmount = srcAmount,
            // so the entire order fills atomically when a taker bids and the
            // bid delay elapses. The auction window is BID_DELAY_SECONDS (30s
            // minimum enforced by TWAP). Within that window any taker can
            // outbid the current winner before fill becomes available.
            const ask = {
                exchange: ADDRESSES.orbsExchangeV2,
                srcToken: tokenIn.address,
                dstToken: tokenOut.address,
                srcAmount: srcAmountBn,
                srcBidAmount: srcAmountBn,
                dstMinAmount: dstMinAmountBn,
                deadline: deadline,
                bidDelay: BID_DELAY_SECONDS,
                fillDelay: FILL_DELAY_SECONDS,
                data: "0x" as const,
            };

            const hash = await writeContractAsync({
                address: ADDRESSES.orbsTwap,
                abi: ORBS_TWAP_ABI,
                functionName: "ask",
                args: [ask],
            });

            pushToast({
                kind: "info",
                title: "Limit order submitted",
                message: `Tx pending. Order goes on-chain.`,
            });

            addActivity({
                type: "swap",
                label: `Limit order placed`,
                value: `${amountIn} ${tokenIn.symbol} ≥ ${triggerPrice} ${tokenOut.symbol}/1`,
                txHash: hash,
                account: account,
            });

            // Reset inputs after submit so the user does not double-submit.
            setAmountIn("");
            setTriggerPrice("");
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Failed to submit order";
            pushToast({ kind: "error", title: "Submit failed", message: msg.slice(0, 120) });
        } finally {
            setSubmitting(false);
        }
    };

    const triggerLabel = useMemo(() => {
        if (!tokenOut) return "When the price reaches";
        return `When 1 ${tokenIn.symbol} reaches`;
    }, [tokenIn.symbol, tokenOut]);

    const showActionState = (): string => {
        if (!LIMIT_ORDERS_ENABLED) return "Limit orders not configured";
        if (!account) return "Connect wallet";
        if (!tokenOut) return "Pick output token";
        if (srcAmountBn <= 0n) return "Enter amount";
        if (srcAmountBn > balance) return "Insufficient balance";
        if (dstMinAmountBn <= 0n) return "Enter trigger price";
        if (expirySeconds <= 0) return "Pick expiry";
        if (needsApproval) return "Approve then Submit";
        if (isWriting || submitting) return "Submitting...";
        return "Place limit order";
    };

    return (
        <>
            <div className="arc-card p-5 sm:p-6">
                <div className="mb-4 flex items-center justify-between">
                    <SwapTabs tab={tab} onTabChange={onTabChange} />
                    <button
                        title="Limit orders are settled on-chain by the Orbs TWAP protocol against Arcade's V2 pools. The order book lives entirely on Arc. 0% Arcade fees."
                        className="text-arc-text-muted hover:text-arc-text"
                    >
                        <Info className="h-4 w-4" />
                    </button>
                </div>

                <TokenRow
                    label="I want to sell"
                    token={tokenIn}
                    amount={amountIn}
                    onAmountChange={setAmountIn}
                    balance={balance}
                    onTokenPick={() => setPickerOpen("in")}
                />

                <div className="my-2 flex justify-center">
                    <button
                        onClick={swapDirection}
                        className="rounded-xl border border-arc-border bg-arc-bg-elevated p-2 text-arc-text-muted hover:text-arc-text"
                    >
                        <ArrowDownUp className="h-4 w-4" />
                    </button>
                </div>

                <TokenRow
                    label="For"
                    token={tokenOut}
                    amount=""
                    disabled
                    placeholder="Pick output token"
                    onTokenPick={() => setPickerOpen("out")}
                />

                <div className="mt-4 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
                    <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs text-arc-text-muted">{triggerLabel}</div>
                        <div className="text-[10px] text-arc-text-faint">
                            {tokenOut ? tokenOut.symbol : "USDC"}/{tokenIn.symbol}
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <input
                            type="text"
                            inputMode="decimal"
                            value={triggerPrice}
                            onChange={(e) => setTriggerPrice(e.target.value)}
                            placeholder="0.0"
                            className="w-full bg-transparent text-2xl font-medium text-arc-text outline-none"
                        />
                        {tokenOut && (
                            <div className="flex items-center gap-2 rounded-lg bg-arc-bg-elevated px-3 py-1.5 text-sm">
                                <AutoTokenIcon address={tokenOut.address} symbol={tokenOut.symbol} size={16} />
                                <span>{tokenOut.symbol}</span>
                            </div>
                        )}
                    </div>
                    {dstMinAmountBn > 0n && tokenOut && (
                        <div className="mt-2 text-[10px] text-arc-text-faint">
                            You receive at least{" "}
                            {formatToken(dstMinAmountBn, tokenOut.decimals, 4)} {tokenOut.symbol}
                        </div>
                    )}
                </div>

                <div className="mt-4">
                    <div className="mb-2 text-xs text-arc-text-muted">Expiry</div>
                    <div className="flex flex-wrap gap-2">
                        {EXPIRY_PRESETS.map((p) => (
                            <button
                                key={p.id}
                                onClick={() => setExpiryId(p.id)}
                                className={cn(
                                    "rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors",
                                    expiryId === p.id
                                        ? "border-arc-cta-hover/50 bg-arc-cta-hover/10 text-arc-text"
                                        : "border-arc-border bg-arc-bg-elevated text-arc-text-muted hover:border-arc-cta-hover/40",
                                )}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                    {expiryId === "custom" && (
                        <div className="mt-3 grid grid-cols-3 gap-2">
                            <CustomNumInput label="Days" value={customDays} onChange={setCustomDays} />
                            <CustomNumInput label="Hours" value={customHours} onChange={setCustomHours} />
                            <CustomNumInput label="Minutes" value={customMinutes} onChange={setCustomMinutes} />
                        </div>
                    )}
                </div>

                <button
                    onClick={onSubmit}
                    disabled={!canSubmit}
                    className={cn(
                        "arc-button-primary mt-5 w-full py-3 text-base font-semibold",
                        !canSubmit && "cursor-not-allowed opacity-50",
                    )}
                >
                    {showActionState()}
                </button>

                <div className="mt-3 text-center text-[10px] text-arc-text-faint">
                    0% Arcade fees, no hidden spread. Order lives on-chain on Arc. Cancel anytime.
                </div>

                {pickerOpen && (
                    <TokenSelectModal
                        open={!!pickerOpen}
                        onClose={() => setPickerOpen(null)}
                        onSelect={(t: TokenOption) => {
                            if (pickerOpen === "in") setTokenIn(t);
                            else setTokenOut(t);
                            setPickerOpen(null);
                        }}
                        tokens={tokenOptions.filter(
                            (t) =>
                                t.address !==
                                (pickerOpen === "in" ? tokenOut?.address : tokenIn.address),
                        )}
                    />
                )}
            </div>

            {account && LIMIT_ORDERS_ENABLED && (
                <OpenOrdersPanel account={account} v2Tokens={v2Tokens} />
            )}
        </>
    );
}

function TokenRow({
    label,
    token,
    amount,
    onAmountChange,
    balance,
    onTokenPick,
    disabled,
    placeholder,
}: {
    label: string;
    token: TokenOption | undefined;
    amount: string;
    onAmountChange?: (s: string) => void;
    balance?: bigint;
    onTokenPick: () => void;
    disabled?: boolean;
    placeholder?: string;
}) {
    return (
        <div className="rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
            <div className="mb-2 flex items-center justify-between">
                <div className="text-xs text-arc-text-muted">{label}</div>
                {balance !== undefined && token && (
                    <div className="text-[10px] text-arc-text-faint">
                        Balance:{" "}
                        {token.symbol === "USDC"
                            ? formatUSDC(balance, USDC_DECIMALS, 2)
                            : formatToken(balance, token.decimals, 4)}
                    </div>
                )}
            </div>
            <div className="flex items-center justify-between gap-3">
                <input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => onAmountChange?.(e.target.value)}
                    placeholder={placeholder ?? "0.0"}
                    disabled={disabled}
                    className="w-full bg-transparent text-3xl font-medium text-arc-text outline-none"
                />
                <button
                    onClick={onTokenPick}
                    className="flex shrink-0 items-center gap-2 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm hover:bg-white/5"
                >
                    {token ? (
                        <>
                            <AutoTokenIcon address={token.address} symbol={token.symbol} size={18} />
                            <span>{token.symbol}</span>
                        </>
                    ) : (
                        <span className="text-arc-text-muted">Select</span>
                    )}
                    <ChevronDown className="h-3 w-3 text-arc-text-faint" />
                </button>
            </div>
        </div>
    );
}

function CustomNumInput({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (s: string) => void;
}) {
    return (
        <div className="rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2">
            <input
                type="text"
                inputMode="numeric"
                value={value}
                onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
                className="w-full bg-transparent text-base font-medium text-arc-text outline-none"
            />
            <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">{label}</div>
        </div>
    );
}

/**
 * Open Orders + Order History panel. Reads the on-chain order book directly
 * via twap.orderIdsByMaker(account) and twap.order(id) for each. No backend.
 */
function OpenOrdersPanel({
    account,
    v2Tokens,
}: {
    account: Address;
    v2Tokens: ReturnType<typeof useV2Tokens>["tokens"];
}) {
    const [tab, setTab] = useState<"open" | "history">("open");
    const [now, setNow] = useState(Math.floor(Date.now() / 1000));

    useEffect(() => {
        const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
        return () => clearInterval(t);
    }, []);

    const idsQ = useReadContract({
        address: ADDRESSES.orbsTwap,
        abi: ORBS_TWAP_ABI,
        functionName: "orderIdsByMaker",
        args: [account],
        query: { refetchInterval: 15_000 },
    });
    const ids = ((idsQ.data as bigint[] | undefined) ?? []).map((b) => Number(b));

    const tokenMap = useMemo(() => {
        const m = new Map<string, { symbol: string; decimals: number }>();
        m.set(ADDRESSES.usdc.toLowerCase(), { symbol: "USDC", decimals: USDC_DECIMALS });
        for (const t of v2Tokens) {
            m.set(t.address.toLowerCase(), { symbol: t.symbol ?? "TOKEN", decimals: 18 });
        }
        return m;
    }, [v2Tokens]);

    return (
        <div className="arc-card mt-4 p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-4">
                <button
                    onClick={() => setTab("open")}
                    className={cn(
                        "text-sm font-semibold transition-colors",
                        tab === "open" ? "text-arc-text" : "text-arc-text-muted hover:text-arc-text",
                    )}
                >
                    Open Orders
                </button>
                <button
                    onClick={() => setTab("history")}
                    className={cn(
                        "text-sm font-semibold transition-colors",
                        tab === "history" ? "text-arc-text" : "text-arc-text-muted hover:text-arc-text",
                    )}
                >
                    Order History
                </button>
                <button
                    onClick={() => idsQ.refetch()}
                    className="ml-auto rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-1 text-xs text-arc-text-muted hover:text-arc-text"
                >
                    Refresh
                </button>
            </div>

            {ids.length === 0 ? (
                <div className="py-6 text-center text-xs text-arc-text-faint">
                    {tab === "open" ? "No open orders." : "No order history."}
                </div>
            ) : (
                <div className="space-y-2">
                    {ids
                        .slice()
                        .reverse()
                        .map((id) => (
                            <OrderRow
                                key={id}
                                id={id}
                                now={now}
                                tab={tab}
                                tokenMap={tokenMap}
                            />
                        ))}
                </div>
            )}
        </div>
    );
}

function OrderRow({
    id,
    now,
    tab,
    tokenMap,
}: {
    id: number;
    now: number;
    tab: "open" | "history";
    tokenMap: Map<string, { symbol: string; decimals: number }>;
}) {
    const orderQ = useReadContract({
        address: ADDRESSES.orbsTwap,
        abi: ORBS_TWAP_ABI,
        functionName: "order",
        args: [BigInt(id)],
        query: { refetchInterval: 15_000 },
    });

    const { writeContractAsync, isPending } = useWriteContract();

    if (!orderQ.data) {
        return (
            <div className="rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-3 text-xs text-arc-text-faint">
                Loading order #{id}...
            </div>
        );
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
    };
    const order = orderQ.data as OrderTuple;
    const state = decodeOrderStatus(order.status, now);

    if (tab === "open" && state !== "open") return null;
    if (tab === "history" && state === "open") return null;

    const src = tokenMap.get(order.ask.srcToken.toLowerCase()) ?? { symbol: "?", decimals: 18 };
    const dst = tokenMap.get(order.ask.dstToken.toLowerCase()) ?? { symbol: "?", decimals: 18 };

    const filledPct = order.ask.srcAmount > 0n
        ? Number((order.srcFilledAmount * 1000n) / order.ask.srcAmount) / 10
        : 0;

    const onCancel = async () => {
        try {
            await writeContractAsync({
                address: ADDRESSES.orbsTwap,
                abi: ORBS_TWAP_ABI,
                functionName: "cancel",
                args: [BigInt(id)],
            });
            pushToast({ kind: "info", title: `Order #${id} cancelled` });
            orderQ.refetch();
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Cancel failed";
            pushToast({ kind: "error", title: "Cancel failed", message: msg.slice(0, 120) });
        }
    };

    return (
        <div className="rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-arc-text-faint">#{id}</span>
                        <StatusPill state={state} />
                    </div>
                    <div className="mt-1 truncate text-sm text-arc-text">
                        Sell {formatToken(order.ask.srcAmount, src.decimals, 4)} {src.symbol} for{" "}
                        {dst.symbol} (≥ {formatToken(order.ask.dstMinAmount, dst.decimals, 4)})
                    </div>
                    {filledPct > 0 && (
                        <div className="mt-1 text-[10px] text-arc-text-faint">
                            Filled: {filledPct.toFixed(1)}%
                        </div>
                    )}
                    {state === "open" && (
                        <div className="mt-1 text-[10px] text-arc-text-faint">
                            Expires:{" "}
                            {order.ask.deadline > 0
                                ? new Date(order.ask.deadline * 1000).toLocaleString()
                                : "no expiry"}
                        </div>
                    )}
                </div>
                {state === "open" && (
                    <button
                        onClick={onCancel}
                        disabled={isPending}
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-arc-danger/40 bg-arc-danger/10 px-2 py-1 text-[10px] text-arc-danger hover:bg-arc-danger/20 disabled:opacity-50"
                        title="Cancel this order on-chain"
                    >
                        <X className="h-3 w-3" />
                        Cancel
                    </button>
                )}
            </div>
        </div>
    );
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
        <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider", color)}>
            {state}
        </span>
    );
}
