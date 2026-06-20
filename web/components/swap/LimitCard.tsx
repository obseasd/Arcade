"use client";

import { ArrowDownUp, ChevronDown } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi, formatUnits, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { V3_QUOTER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, LIMIT_ORDERS_ENABLED, USDC_DECIMALS, V3_FEE } from "@/lib/constants";
import { TransactionSettings } from "@/components/ui/TransactionSettings";
import { QuickButton } from "@/components/swap/QuickButton";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { buildApproveAndCall } from "@/lib/routing/batchSwap";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { ORBS_TWAP_ABI } from "@/lib/abis/orbsTwap";
import { addActivity } from "@/lib/activityFeed";
import { pushToast } from "@/lib/toast";
import { SwapTabs, type SwapTab } from "./SwapTabs";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

/**
 * Format a number as a price string. Strips trailing zeros and the trailing
 * dot. Caps at 6 significant fractional digits to avoid scientific notation
 * for very small prices typical of fresh launchpad tokens.
 */
function formatPriceStr(price: number, maxDecimals = 6): string {
    if (!isFinite(price) || price === 0) return "";
    const str = price.toFixed(maxDecimals);
    return str.replace(/\.?0+$/, "");
}

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

/** Hard ceiling on the order's deadline. Orbs Twap accepts arbitrary
 *  deadlines, but a 90-day cap keeps stale orders from cluttering the UI
 *  list forever and matches the limit-order conventions on other DEXes
 *  (Uniswap, 1inch, Hyperswap). Custom-expiry input is clamped to this
 *  value before submit. */
const MAX_EXPIRY_SECONDS = 90 * 24 * 60 * 60;

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
    const { tokens: v3Tokens } = useV3Tokens();

    const [tokenIn, setTokenIn] = useState<TokenOption>(USDC_TOKEN);
    const [tokenOut, setTokenOut] = useState<TokenOption | undefined>(undefined);
    const [amountIn, setAmountIn] = useState("");
    const [triggerPrice, setTriggerPrice] = useState("");
    const [forAmount, setForAmount] = useState("");
    const [expiryId, setExpiryId] = useState<ExpiryId>("7d");
    const [customDays, setCustomDays] = useState("0");
    const [customHours, setCustomHours] = useState("0");
    const [customMinutes, setCustomMinutes] = useState("10");
    const [pickerOpen, setPickerOpen] = useState<"in" | "out" | null>(null);
    const [submitting, setSubmitting] = useState(false);
    // Slippage tolerance applied below the trigger price to compute the
    // dstMinAmount floor in the on-chain Ask. 0.5% default matches the
    // regular Swap card.
    const [slippageBps, setSlippageBps] = useState(50);
    const [slippageCustom, setSlippageCustom] = useState("");
    const [showSettings, setShowSettings] = useState(false);
    // Ref used to dedupe the bidirectional sync between triggerPrice and
    // forAmount: when one of them is updated as a derived side-effect of
    // editing the other, the corresponding useEffect skips the next sync
    // pass to avoid a feedback loop.
    const skipNextSyncRef = useRef<"none" | "for" | "trigger">("none");

    // Same combined V2 + V3 + USDC list the regular Swap tab uses, deduped.
    // V2 tokens are settleable through Orbs ExchangeV2 (routes our V2 router);
    // V3 / Clanker tokens are surfaced for completeness even though limit
    // orders against pure V3 single-sided pools will not fill via the Orbs
    // taker until we deploy a V3-aware exchange adapter. We include them so
    // users can at least see all their launchpad holdings in the picker.
    const tokenOptions = useMemo<TokenOption[]>(() => {
        const seen = new Set<string>();
        const out: TokenOption[] = [];
        const merged = [
            USDC_TOKEN,
            ...v2Tokens.map((t) => ({
                address: t.address,
                symbol: t.symbol ?? "TOKEN",
                name: t.name ?? "Token",
                decimals: t.decimals ?? 18,
                pinned: false,
            })),
            ...v3Tokens.map((t) => ({
                address: t.address,
                symbol: t.symbol ?? "TOKEN",
                name: t.name ?? "Token",
                decimals: t.decimals ?? 18,
                pinned: false,
            })),
        ];
        for (const t of merged) {
            const k = t.address.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(t);
        }
        return out;
    }, [v2Tokens, v3Tokens]);

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
            const total = d * 86400 + h * 3600 + m * 60;
            // Clamp to MAX_EXPIRY_SECONDS (90 days). Above that we just
            // pin to the ceiling silently; the validation message below
            // surfaces it.
            return Math.min(total, MAX_EXPIRY_SECONDS);
        }
        return EXPIRY_PRESETS.find((p) => p.id === expiryId)?.seconds ?? 0;
    }, [expiryId, customDays, customHours, customMinutes]);

    /** Raw (un-clamped) custom duration for the over-90-days warning. */
    const customRequestedSeconds = useMemo(() => {
        if (expiryId !== "custom") return 0;
        const d = Math.max(0, parseInt(customDays || "0", 10));
        const h = Math.max(0, parseInt(customHours || "0", 10));
        const m = Math.max(0, parseInt(customMinutes || "0", 10));
        return d * 86400 + h * 3600 + m * 60;
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

    // Expected output = srcAmount * triggerPrice, in BigInt at outDec precision.
    // This is what the For field shows when it is derived (not user-edited).
    const expectedOutBn = useMemo(() => {
        if (!tokenOut || !triggerPrice || Number(triggerPrice) <= 0) return 0n;
        try {
            const triggerBn = parseUnits(triggerPrice, outDec);
            return (srcAmountBn * triggerBn) / 10n ** BigInt(inDec);
        } catch {
            return 0n;
        }
    }, [tokenOut, triggerPrice, srcAmountBn, inDec, outDec]);

    // dstMinAmount = expected output reduced by slippage tolerance. This is
    // the on-chain floor in the Ask struct. Maker is willing to accept
    // anywhere between this floor and the expected output; takers compete
    // above the floor.
    const dstMinAmountBn = useMemo(() => {
        if (expectedOutBn === 0n) return 0n;
        return (expectedOutBn * BigInt(10_000 - slippageBps)) / 10_000n;
    }, [expectedOutBn, slippageBps]);

    // Spot price quote: how many tokenOut per 1 tokenIn at current pool reserves.
    // Used to populate triggerPrice on token pick + drive the Market Price button.
    // Two queries fire in parallel and we use whichever returns first:
    //   - V2: ArcadeV2Router.getAmountsOut(1 unit) for tokens that migrated.
    //   - V3: ArcadeV3Quoter.quoteExactInputSingle(1 unit) for CLANKER_V3 launches.
    // wagmi disables the irrelevant call automatically based on the isV3Token
    // check below, so we only ever ping the right router.
    const oneInBn = useMemo(() => 10n ** BigInt(inDec), [inDec]);
    const spotPath = useMemo<readonly Address[]>(() => {
        if (!tokenOut) return [];
        return [tokenIn.address, tokenOut.address] as const;
    }, [tokenIn.address, tokenOut]);

    // V3 token detection: a token is V3 iff it appears in useV3Tokens output
    // (which is sourced from launchpad mode == CLANKER_V3) AND is not also in
    // useV2Tokens (migration would put it in v2Tokens).
    const isV3Out = useMemo<boolean>(() => {
        if (!tokenOut) return false;
        const addrLower = tokenOut.address.toLowerCase();
        return (
            !v2Tokens.some((t) => t.address.toLowerCase() === addrLower) &&
            v3Tokens.some((t) => t.address.toLowerCase() === addrLower)
        );
    }, [tokenOut, v2Tokens, v3Tokens]);
    const isV3In = useMemo<boolean>(() => {
        const addrLower = tokenIn.address.toLowerCase();
        return (
            !v2Tokens.some((t) => t.address.toLowerCase() === addrLower) &&
            v3Tokens.some((t) => t.address.toLowerCase() === addrLower)
        );
    }, [tokenIn.address, v2Tokens, v3Tokens]);
    const isV3Path = isV3Out || isV3In;

    const v2SpotQ = useReadContract({
        address: ADDRESSES.router,
        abi: ROUTER_ABI,
        functionName: "getAmountsOut",
        args: tokenOut ? [oneInBn, spotPath] : undefined,
        query: { enabled: !!tokenOut && !isV3Path, refetchInterval: 15_000 },
    });
    const v3SpotQ = useReadContract({
        address: ADDRESSES.v3Quoter,
        abi: V3_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: tokenOut ? [tokenIn.address, tokenOut.address, V3_FEE, oneInBn] : undefined,
        query: { enabled: !!tokenOut && isV3Path, refetchInterval: 15_000 },
    });

    const spotOutBn = useMemo<bigint | undefined>(() => {
        if (isV3Path) {
            return v3SpotQ.data as bigint | undefined;
        }
        const arr = v2SpotQ.data as readonly bigint[] | undefined;
        if (!arr || arr.length < 2) return undefined;
        return arr[arr.length - 1];
    }, [isV3Path, v2SpotQ.data, v3SpotQ.data]);

    const marketPriceNum = useMemo(() => {
        if (!spotOutBn || !tokenOut) return 0;
        return Number(formatUnits(spotOutBn, outDec));
    }, [spotOutBn, tokenOut, outDec]);
    const marketPriceStr = useMemo(() => formatPriceStr(marketPriceNum), [marketPriceNum]);

    // Triger-vs-market delta: positive when limit price asks more than market.
    const triggerVsMarketPct = useMemo(() => {
        if (!triggerPrice || marketPriceNum <= 0) return 0;
        const t = Number(triggerPrice);
        if (!isFinite(t) || t <= 0) return 0;
        return (t / marketPriceNum - 1) * 100;
    }, [triggerPrice, marketPriceNum]);

    // Bidirectional sync between forAmount and triggerPrice.
    //
    // The user can edit any of: srcAmount, triggerPrice, forAmount.
    // Math: forAmount = srcAmount * triggerPrice (in token units).
    // So we have two independent variables and the third is derived.
    //
    // We always treat srcAmount as user-driven (it's the input the maker
    // commits). Between triggerPrice and forAmount, the one the user just
    // typed is independent and the other gets recomputed. The ref
    // skipNextSyncRef is used to break the otherwise-infinite loop when
    // one of them updates the other.

    const onSrcAmountChange = (s: string) => {
        setAmountIn(s);
        // forAmount auto-derives from the sync effect below.
    };

    const onTriggerChange = (s: string) => {
        setTriggerPrice(s);
        // forAmount auto-derives from the sync effect below.
    };

    const onForChange = (s: string) => {
        setForAmount(s);
        // Editing For: there are 3 fields (From, Trigger, For) and only 2 are
        // independent. Choose which field to derive based on what the user
        // most recently edited:
        //   - Trigger set + From empty -> derive From (legacy behavior).
        //   - From set + Trigger empty -> derive Trigger from (For / From).
        //     This is the natural "I have N USDC, I want M tokens, set the
        //     limit price for me" flow that the prior code broke by
        //     clearing From the moment the user touched For without first
        //     setting Trigger.
        //   - Both set -> keep both, derive Trigger again (last-edit wins).
        //   - Neither set -> nothing to derive, leave From alone.
        // skipNextSyncRef stays "for" so the From-or-Trigger auto-sync
        // effect below doesn't immediately overwrite forAmount.
        skipNextSyncRef.current = "for";
        const fr = Number(s);
        if (!isFinite(fr) || fr <= 0) {
            // Empty / invalid For value: don't clobber From, just leave it.
            return;
        }
        const tp = Number(triggerPrice);
        const srcAmt = Number(amountIn);
        const triggerSet = !!triggerPrice && isFinite(tp) && tp > 0;
        const fromSet = !!amountIn && isFinite(srcAmt) && srcAmt > 0;
        if (triggerSet && !fromSet) {
            // Trigger fixed, derive From = For / Trigger.
            setAmountIn(formatPriceStr(fr / tp, 8));
            return;
        }
        if (fromSet) {
            // From fixed, derive Trigger = For / From (price per src unit).
            setTriggerPrice(formatPriceStr(fr / srcAmt, 8));
            return;
        }
        // Neither side set: just store For, nothing else to compute yet.
    };

    // When srcAmount or triggerPrice changes (and we are not currently inside
    // a user-typed-into-For loop), recompute forAmount from the derived math.
    useEffect(() => {
        if (skipNextSyncRef.current === "for") {
            skipNextSyncRef.current = "none";
            return;
        }
        if (!tokenOut || expectedOutBn === 0n) {
            setForAmount("");
            return;
        }
        setForAmount(formatToken(expectedOutBn, outDec, 6).replace(/,/g, ""));
        skipNextSyncRef.current = "none";
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [amountIn, triggerPrice, tokenOut?.address, expectedOutBn, outDec]);

    // Auto-populate triggerPrice with the current market price when the user
    // first interacts with the form: picks tokenOut, types into srcAmount, or
    // the market price quote finally lands. Only auto-fills when triggerPrice
    // is empty so a user-typed value is never overwritten. Subsequent token
    // swaps via the up-down arrow clear triggerPrice in swapDirection() which
    // re-triggers this effect on the new pair.
    useEffect(() => {
        if (tokenOut && marketPriceStr && !triggerPrice && srcAmountBn > 0n) {
            setTriggerPrice(marketPriceStr);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tokenOut?.address, marketPriceStr, srcAmountBn]);

    const onSlippagePreset = (bps: number) => {
        setSlippageBps(bps);
        setSlippageCustom("");
    };
    const onSlippageCustom = (v: string) => {
        const cleaned = v.replace(/[^0-9.]/g, "");
        setSlippageCustom(cleaned);
        const n = Number(cleaned);
        if (isFinite(n) && n >= 0 && n <= 50) {
            setSlippageBps(Math.round(n * 100));
        }
    };

    const { allowance } = useApproveIfNeeded(
        tokenIn.address,
        ADDRESSES.orbsTwap,
    );
    const needsApproval = allowance < srcAmountBn;

    const { writeContractAsync, isPending: isWriting } = useWriteContract();
    const publicClient = usePublicClient();

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
        setForAmount("");
        skipNextSyncRef.current = "none";
    };

    const onSubmit = async () => {
        if (!canSubmit || !tokenOut || !account) return;
        if (tokenOut.address === zeroAddress) {
            pushToast({ kind: "error", title: "Invalid output token" });
            return;
        }

        setSubmitting(true);
        try {
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

            let hash: `0x${string}`;
            if (needsApproval) {
                // Fold the one-time TWAP approval + the order into a single
                // sender-preserving signature (Arc Multicall3From).
                const batched = buildApproveAndCall({
                    token: tokenIn.address,
                    spender: ADDRESSES.orbsTwap,
                    call: { address: ADDRESSES.orbsTwap, abi: ORBS_TWAP_ABI, functionName: "ask", args: [ask] },
                });
                hash = await writeContractAsync({
                    address: batched.address,
                    abi: batched.abi,
                    functionName: batched.functionName,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    args: batched.args as any,
                });
            } else {
                hash = await writeContractAsync({
                    address: ADDRESSES.orbsTwap,
                    abi: ORBS_TWAP_ABI,
                    functionName: "ask",
                    args: [ask],
                });
            }

            // 2026-06-15 audit HIGH#4 fix: writeContractAsync resolves the
            // moment the wallet returns a hash (post-signature, pre-mining),
            // so a reverted on-chain `ask` (deadline expired, allowance
            // race, paused TWAP, bidDelay rejected) previously sailed
            // through the happy path: success toast, Activity row, form
            // cleared - while the Open Orders panel stayed empty. Wait for
            // the receipt and gate the rest of the flow on receipt.status
            // so revert lands in the catch with a real error toast.
            if (publicClient) {
                const receipt = await publicClient.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") {
                    throw new Error(`Limit order reverted on-chain. Tx: ${hash}`);
                }
            }

            pushToast({
                kind: "info",
                title: "Limit order placed",
                message: `Order on-chain.`,
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
            // Refresh source-token balance so the From-side label updates
            // immediately. Without this, the cached pre-order balance
            // continues to allow back-to-back orders past the wallet's
            // actual available balance (audit HIGH#4 / medium balance-stale).
            void balanceQ.refetch();
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
        <div className="arc-card relative p-5">
                <div className="mb-4 flex items-center justify-between">
                    <SwapTabs tab={tab} onTabChange={onTabChange} />
                    <TransactionSettings
                        open={showSettings}
                        onToggle={() => setShowSettings((s) => !s)}
                        onClose={() => setShowSettings(false)}
                        slippageBps={slippageBps}
                        slippageCustom={slippageCustom}
                        onPreset={onSlippagePreset}
                        onCustom={onSlippageCustom}
                    />
                </div>

                <TokenRow
                    label="From"
                    token={tokenIn}
                    amount={amountIn}
                    onAmountChange={onSrcAmountChange}
                    balance={balance}
                    showHalfMax={!!account && balance > 0n}
                    onHalf={() => {
                        try {
                            onSrcAmountChange(formatUnits(balance / 2n, inDec));
                        } catch {
                            /* noop */
                        }
                    }}
                    onMax={() => {
                        try {
                            onSrcAmountChange(formatUnits(balance, inDec));
                        } catch {
                            /* noop */
                        }
                    }}
                    onTokenPick={() => setPickerOpen("in")}
                />

                <div className="relative z-10 -my-2 flex justify-center">
                    <button type="button"
                        onClick={swapDirection}
                        className="rounded-xl border border-arc-border bg-arc-surface-2/40 p-2 backdrop-blur-md transition-all hover:bg-arc-surface-3/60 active:scale-95"
                    >
                        <ArrowDownUp className="h-4 w-4 text-arc-text" />
                    </button>
                </div>

                <TokenRow
                    label="For"
                    token={tokenOut}
                    amount={forAmount}
                    onAmountChange={onForChange}
                    placeholder={tokenOut ? "0.0" : "Pick output token"}
                    onTokenPick={() => setPickerOpen("out")}
                />

                <div className="mt-4 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
                    <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs text-arc-text-muted">{triggerLabel}</div>
                        <button
                            type="button"
                            onClick={() => {
                                if (marketPriceStr) setTriggerPrice(marketPriceStr);
                            }}
                            disabled={!marketPriceStr}
                            className={cn(
                                "rounded-lg border border-arc-border bg-arc-bg-elevated px-2 py-1 text-[10px] font-medium transition-colors",
                                marketPriceStr
                                    ? "text-arc-text-muted hover:bg-white/5 hover:text-arc-text"
                                    : "cursor-not-allowed text-arc-text-faint opacity-50",
                            )}
                        >
                            Market Price
                        </button>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <input
                            aria-label="Trigger price"
                            type="text"
                            inputMode="decimal"
                            value={triggerPrice}
                            onChange={(e) => onTriggerChange(e.target.value)}
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
                    {tokenOut && marketPriceStr && (
                        <div className="mt-2 text-[10px] text-arc-text-faint">
                            Current market: {marketPriceStr} {tokenOut.symbol}/{tokenIn.symbol}
                        </div>
                    )}
                    {tokenOut && marketPriceStr && triggerPrice && triggerVsMarketPct !== 0 && (
                        <div
                            className={cn(
                                "mt-1 text-[10px]",
                                triggerVsMarketPct > 0 ? "text-arc-success" : "text-arc-warn",
                            )}
                        >
                            Your limit price is {Math.abs(triggerVsMarketPct).toFixed(2)}%{" "}
                            {triggerVsMarketPct > 0 ? "higher" : "lower"} than market
                        </div>
                    )}
                </div>

                {/* Route + min-out row. Inline (no card chrome) to match the
                    regular Swap card's "via Arcade X" line exactly. Right side
                    shows the slippage-adjusted floor encoded in the on-chain
                    Ask, not the price ratio (limit orders care about the floor,
                    market swaps care about the ratio). */}
                {tokenOut && expectedOutBn > 0n && (
                    <div className="mt-4 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5 text-arc-text-muted">
                            <Image
                                src="/route.png"
                                alt=""
                                width={14}
                                height={14}
                                className="h-3.5 w-3.5 opacity-75"
                            />
                            <span>via</span>
                            <span className="font-medium text-arc-text">
                                {isV3Path ? "Arcade V3" : "Arcade V2"}
                            </span>
                            {isV3Path && (
                                <span className="ml-1 rounded-full border border-arc-success/40 bg-arc-success/10 px-1.5 py-0.5 text-[10px] font-medium text-arc-success">
                                    locked-LP pool
                                </span>
                            )}
                        </div>
                        <div className="text-arc-text-muted tabular-nums">
                            Min:{" "}
                            <span className="text-arc-text">
                                {formatToken(dstMinAmountBn, outDec, 4)}
                            </span>{" "}
                            {tokenOut.symbol}
                        </div>
                    </div>
                )}

                <div className="mt-4">
                    <div className="mb-2 text-xs text-arc-text-muted">Expiry</div>
                    <div className="flex flex-wrap gap-1.5">
                        {EXPIRY_PRESETS.map((p) => (
                            <button type="button"
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
                        <>
                            <div className="mt-3 grid grid-cols-3 gap-2">
                                <CustomNumInput label="Days" value={customDays} onChange={setCustomDays} />
                                <CustomNumInput label="Hours" value={customHours} onChange={setCustomHours} />
                                <CustomNumInput label="Minutes" value={customMinutes} onChange={setCustomMinutes} />
                            </div>
                            {customRequestedSeconds > MAX_EXPIRY_SECONDS && (
                                <div className="mt-2 text-[11px] text-arc-warn">
                                    Max expiry is 90 days. Your input will be clamped.
                                </div>
                            )}
                        </>
                    )}
                </div>

                <button type="button"
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

/**
 * Token amount row used by the Limit card. Mirrors the chrome of the regular
 * SwapCard's TokenBox so the two cards line up to the pixel when the user
 * switches tabs: same outer border + transparency, same header layout (label
 * on the left, token chip on the right), same input scale, same footer slot
 * that holds the balance and HALF/MAX buttons.
 */
function TokenRow({
    label,
    token,
    amount,
    onAmountChange,
    balance,
    showHalfMax,
    onHalf,
    onMax,
    onTokenPick,
    disabled,
    placeholder,
}: {
    label: string;
    token: TokenOption | undefined;
    amount: string;
    onAmountChange?: (s: string) => void;
    balance?: bigint;
    showHalfMax?: boolean;
    onHalf?: () => void;
    onMax?: () => void;
    onTokenPick: () => void;
    disabled?: boolean;
    placeholder?: string;
}) {
    const decimals = token?.decimals ?? 18;
    const balLabel =
        token && balance !== undefined
            ? decimals === USDC_DECIMALS
                ? formatUSDC(balance, decimals, 2)
                : formatToken(balance, decimals, 4)
            : undefined;

    return (
        <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5 transition-colors focus-within:border-arc-border-strong">
            {/* Header: label + token chip */}
            <div className="mb-3 flex items-center justify-between">
                <span className="text-sm text-arc-text-muted">{label}</span>
                <button type="button"
                    onClick={onTokenPick}
                    className="group flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-2 text-base font-semibold transition-colors hover:bg-arc-surface-3"
                >
                    {token ? (
                        <>
                            <AutoTokenIcon address={token.address} symbol={token.symbol} size={24} />
                            <span>{token.symbol}</span>
                            <ChevronDown className="h-4 w-4 text-arc-text-muted transition-transform group-hover:text-arc-text" />
                        </>
                    ) : (
                        <>
                            <span>Select token</span>
                            <ChevronDown className="h-4 w-4 text-arc-text-muted" />
                        </>
                    )}
                </button>
            </div>

            {/* Amount input */}
            <input
                aria-label="Amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => onAmountChange?.(e.target.value)}
                placeholder={placeholder ?? "0.0"}
                disabled={disabled}
                className="arc-input w-full bg-transparent text-3xl font-medium leading-tight sm:text-4xl"
            />

            {/* Footer: balance left, HALF/MAX right */}
            {(balLabel || showHalfMax) && (
                <div className="mt-3 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 text-arc-text-muted">
                        {balLabel && token && (
                            <span className="text-arc-text-faint">
                                {balLabel} {token.symbol}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5">
                        {showHalfMax && (
                            <>
                                <QuickButton onClick={onHalf}>HALF</QuickButton>
                                <QuickButton onClick={onMax}>MAX</QuickButton>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// QuickButton lives in components/swap/QuickButton (extracted 2026-06-06,
// audit item 8).

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
                aria-label={label}
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

// SlippagePopover replaced by the shared TransactionSettings (components/ui).
// Same gear icon + presets + custom field; the prior Limit-specific footer
// note ("Limit orders fill at or above the trigger price...") was moved into
// the trigger-price input help text where it actually reads.
