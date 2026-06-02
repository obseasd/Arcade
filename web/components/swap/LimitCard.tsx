"use client";

import { ArrowDownUp, ChevronDown, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { erc20Abi, formatUnits, parseUnits, zeroAddress } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
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

interface LimitCardProps {
    tab: SwapTab;
    onTabChange: (t: SwapTab) => void;
}

/**
 * Limit order entry card. Builds a maker EIP-712 order against the vendored
 * Orbs TWAP contract (see contracts/orbs/src/TWAP.sol) and POSTs the signed
 * order to our off-chain mirror.
 *
 * Critical UX gate: the output token (dstToken) MUST be a real ERC20 address.
 * The Orbs TWAP contract has a WETH-unwrap path at TWAP.sol L244-247 that
 * fires when `dstToken == address(0)`; on Arc where USDC is the native gas
 * token, that path either reverts or sends to a wallet with zero native
 * balance. The token picker below sources from useV2Tokens which contains
 * only deployed ERC20s, so the natural input flow never produces a zero
 * dstToken. We additionally assert at submit time as a defense-in-depth.
 *
 * MVP scope: the UI captures all the order parameters, builds the typed-data
 * preview, and stubs the EIP-712 sign + POST. The Orbs deploy on Arc and the
 * off-chain order book API are tracked in orbs-deploy.md.
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

    const canSubmit =
        !!account &&
        !!tokenOut &&
        tokenOut.address !== zeroAddress &&
        Number(amountIn) > 0 &&
        Number(triggerPrice) > 0 &&
        expirySeconds > 0;

    const swapDirection = () => {
        if (!tokenOut) return;
        const newIn = tokenOut;
        const newOut = tokenIn;
        setTokenIn(newIn);
        setTokenOut(newOut);
        setAmountIn("");
        setTriggerPrice("");
    };

    const onSubmit = () => {
        if (!canSubmit || !tokenOut) return;

        // Defense in depth: never allow a zero-address output. The picker
        // naturally prevents this; we re-check on submit because TWAP's
        // unwrap path at L244-247 is the documented risk on USDC-as-gas
        // chains like Arc.
        if (tokenOut.address === zeroAddress) {
            pushToast({ kind: "error", title: "Invalid output token" });
            return;
        }

        // Build the EIP-712 typed data here and call wagmi.signTypedData.
        // Stubbed until orbs-deploy.md lands the TWAP address on Arc; once
        // NEXT_PUBLIC_ORBS_TWAP_ADDRESS is set, this block wires up to:
        //   1. typed data = { domain: { chainId, name, verifyingContract }, ... }
        //   2. signTypedData(typedData) via wagmi
        //   3. POST { order, signature } to /api/limit-orders
        //   4. on success, addActivity({ type: "limit-order-placed", ... })
        pushToast({
            kind: "info",
            title: "Coming soon",
            message: "Orbs TWAP deploy on Arc lands first. Then this flow signs and submits.",
        });
    };

    const triggerPriceLabel = useMemo(() => {
        if (!tokenOut) return "When the price reaches";
        return `When 1 ${tokenIn.symbol} reaches`;
    }, [tokenIn.symbol, tokenOut]);

    return (
        <div className="arc-card p-5 sm:p-6">
            <div className="mb-4 flex items-center justify-between">
                <SwapTabs tab={tab} onTabChange={onTabChange} />
                <button
                    title="Limit orders are settled by the Orbs TWAP protocol against Arcade's V2 pools. No fees, no hidden spread."
                    className="text-arc-text-muted hover:text-arc-text"
                >
                    <Info className="h-4 w-4" />
                </button>
            </div>

            {/* I want to sell */}
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

            {/* For */}
            <TokenRow
                label="For"
                token={tokenOut}
                amount=""
                disabled
                placeholder="Pick output token"
                onTokenPick={() => setPickerOpen("out")}
            />

            {/* Price trigger card */}
            <div className="mt-4 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
                <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs text-arc-text-muted">{triggerPriceLabel}</div>
                    <button
                        disabled={!tokenOut}
                        className="text-[10px] text-arc-cta-hover disabled:opacity-30"
                    >
                        Market Price
                    </button>
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
            </div>

            {/* Expiry */}
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
                {!account
                    ? "Connect wallet"
                    : !tokenOut
                      ? "Pick output token"
                      : Number(amountIn) <= 0
                        ? "Enter amount"
                        : Number(triggerPrice) <= 0
                          ? "Enter trigger price"
                          : "Place limit order"}
            </button>

            <div className="mt-3 text-center text-[10px] text-arc-text-faint">
                0% fees, no hidden spread. Settled by the Orbs TWAP protocol against Arcade V2 pools.
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
