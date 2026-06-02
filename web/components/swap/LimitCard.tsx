"use client";

import { ArrowDownUp, ChevronDown, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { erc20Abi, parseUnits, zeroAddress } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { ADDRESSES, LIMIT_ORDERS_ENABLED, USDC_DECIMALS } from "@/lib/constants";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { ORBS_TWAP_ABI } from "@/lib/abis/orbsTwap";
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
