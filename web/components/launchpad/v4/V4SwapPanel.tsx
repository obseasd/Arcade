"use client";

import { ArrowDownUp, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
    Address,
    erc20Abi,
    formatUnits,
    parseUnits,
    zeroAddress,
} from "viem";
import {
    useAccount,
    usePublicClient,
    useReadContract,
    useWriteContract,
} from "wagmi";
import { V4_LAUNCHPAD_ABI } from "@/lib/abis/v4Launchpad";
import { V4_QUOTER_ABI } from "@/lib/abis/v4Quoter";
import { V4_ROUTER_ABI } from "@/lib/abis/v4Router";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { pushToast } from "@/lib/toast";
import { AmountInput } from "@/components/ui/AmountInput";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { cn, formatUSDC } from "@/lib/utils";

const TOKEN_DECIMALS = 18;

interface PoolKey {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
}

interface Props {
    token: Address;
    /** ERC20 symbol of the launch token (for display). */
    symbol?: string;
}

/**
 * V4 swap panel for a single token paired with USDC. Quotes via V4Quoter
 * (off-chain simulate) and submits via ArcadeV4SwapRouter.
 *
 * Exact-in only for the MVP: user picks input amount + direction (Buy: USDC
 * -> token, Sell: token -> USDC). Slippage tolerance defaults to 0.5%.
 */
export function V4SwapPanel({ token, symbol }: Props) {
    const { address: user, isConnected } = useAccount();
    const publicClient = usePublicClient();
    const { writeContractAsync } = useWriteContract();

    const launchpad = ADDRESSES.v4Launchpad;
    const router = ADDRESSES.v4Router;
    const quoter = ADDRESSES.v4Quoter;
    const usdc = ADDRESSES.usdc;

    const [direction, setDirection] = useState<"buy" | "sell">("buy");
    const [amountIn, setAmountIn] = useState("");
    const [slippageBps, setSlippageBps] = useState(50); // 0.5%
    const [swapState, setSwapState] = useState<TxState>({ status: "idle" });
    const [showSettings, setShowSettings] = useState(false);

    // --- PoolKey + token sort --------------------------------------------
    const launchQ = useReadContract({
        address: launchpad,
        abi: V4_LAUNCHPAD_ABI,
        functionName: "getLaunch",
        args: [token],
    });
    const launch = launchQ.data as
        | {
              poolKey: PoolKey;
          }
        | undefined;
    const poolKey = launch?.poolKey;
    const tokenIsCurrency0 = poolKey
        ? poolKey.currency0.toLowerCase() === token.toLowerCase()
        : undefined;

    // BUY = USDC -> TOKEN. zeroForOne depends on which currency USDC is.
    const zeroForOne = useMemo(() => {
        if (tokenIsCurrency0 === undefined) return undefined;
        // BUY: input = USDC, output = TOKEN
        // SELL: input = TOKEN, output = USDC
        if (direction === "buy") {
            return !tokenIsCurrency0; // USDC is currency0 when token is currency1
        }
        return tokenIsCurrency0;
    }, [direction, tokenIsCurrency0]);

    const inputDecimals = direction === "buy" ? USDC_DECIMALS : TOKEN_DECIMALS;
    const outputDecimals = direction === "buy" ? TOKEN_DECIMALS : USDC_DECIMALS;
    const inputSymbol = direction === "buy" ? "USDC" : symbol ?? "TOKEN";
    const outputSymbol = direction === "buy" ? symbol ?? "TOKEN" : "USDC";

    // --- Balances --------------------------------------------------------
    const inputAddr = direction === "buy" ? usdc : token;
    const balanceQ = useReadContract({
        address: inputAddr,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: user ? [user] : undefined,
        query: { enabled: !!user, refetchInterval: 12_000 },
    });
    const balance = (balanceQ.data as bigint | undefined) ?? 0n;

    // --- Allowance for the router (USDC or token, whichever is input) ----
    const { allowance, ensureAllowance } = useApproveIfNeeded(inputAddr, router);

    // --- Quote via V4Quoter ---------------------------------------------
    const [quote, setQuote] = useState<bigint | undefined>();
    const [quoteLoading, setQuoteLoading] = useState(false);
    const [quoteError, setQuoteError] = useState<string | undefined>();
    const amountInBigInt = useMemo(() => {
        if (!amountIn || Number.isNaN(Number(amountIn))) return 0n;
        try {
            return parseUnits(amountIn, inputDecimals);
        } catch {
            return 0n;
        }
    }, [amountIn, inputDecimals]);

    useEffect(() => {
        if (!publicClient || !poolKey || zeroForOne === undefined) {
            setQuote(undefined);
            return;
        }
        if (amountInBigInt === 0n || quoter === zeroAddress) {
            setQuote(undefined);
            return;
        }
        let cancelled = false;
        setQuoteLoading(true);
        setQuoteError(undefined);
        (async () => {
            try {
                const { result } = await publicClient.simulateContract({
                    address: quoter,
                    abi: V4_QUOTER_ABI,
                    functionName: "quoteExactInputSingle",
                    args: [
                        {
                            poolKey: {
                                currency0: poolKey.currency0,
                                currency1: poolKey.currency1,
                                fee: poolKey.fee,
                                tickSpacing: poolKey.tickSpacing,
                                hooks: poolKey.hooks,
                            },
                            zeroForOne,
                            exactAmount: amountInBigInt,
                            hookData: "0x" as `0x${string}`,
                        },
                    ],
                });
                if (!cancelled) {
                    const [amountOut] = result as readonly [bigint, bigint];
                    setQuote(amountOut);
                }
            } catch (e) {
                if (!cancelled) {
                    setQuote(undefined);
                    setQuoteError(e instanceof Error ? e.message : String(e));
                }
            } finally {
                if (!cancelled) setQuoteLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [publicClient, poolKey, zeroForOne, amountInBigInt, quoter]);

    // Slippage floor.
    const minAmountOut = useMemo(() => {
        if (!quote) return 0n;
        // floor = quote * (10_000 - slippageBps) / 10_000
        return (quote * BigInt(10_000 - slippageBps)) / 10_000n;
    }, [quote, slippageBps]);

    // --- Swap action ----------------------------------------------------
    const { image: tokenImage } = useTokenImage(token);

    async function onSwap() {
        if (!user || !poolKey || zeroForOne === undefined) {
            pushToast({ kind: "error", title: "Wallet not connected" });
            return;
        }
        if (router === zeroAddress) {
            pushToast({ kind: "error", title: "V4 router address not configured" });
            return;
        }
        if (amountInBigInt === 0n) {
            pushToast({ kind: "error", title: "Enter an amount" });
            return;
        }
        if (!quote || quote === 0n) {
            pushToast({ kind: "error", title: "Quote unavailable" });
            return;
        }
        try {
            const swapArgs = [
                {
                    currency0: poolKey.currency0,
                    currency1: poolKey.currency1,
                    fee: poolKey.fee,
                    tickSpacing: poolKey.tickSpacing,
                    hooks: poolKey.hooks,
                },
                zeroForOne,
                amountInBigInt,
                minAmountOut,
                user,
                0n, // sqrtPriceLimitX96 = unlimited within tick range
            ] as const;
            // Arc's callFrom precompile is dead, so the old "approve + swap
            // in one signature" Multicall3From batch reverts on-chain. Run
            // the legs as direct txs from the user's wallet: approve first
            // (only on the first swap of this token), then exactInputSingle.
            // msg.sender is the user on each tx for free.
            let hash: `0x${string}`;
            if (allowance < amountInBigInt) {
                setSwapState({ status: "pending", message: "Approving..." });
                await ensureAllowance(amountInBigInt);
            }
            setSwapState({ status: "pending", message: "Submitting swap..." });
            hash = await writeContractAsync({
                address: router,
                abi: V4_ROUTER_ABI,
                functionName: "exactInputSingle",
                args: swapArgs,
            });
            setSwapState({ status: "pending", message: "Waiting for confirmation..." });
            await publicClient?.waitForTransactionReceipt({ hash });
            setSwapState({ status: "success", hash, message: "Swap confirmed" });
            setAmountIn("");
            // Refetch balance.
            balanceQ.refetch();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setSwapState({ status: "error", message: msg });
        }
    }

    const insufficientBalance = amountInBigInt > balance;
    const canSwap =
        isConnected &&
        amountInBigInt > 0n &&
        !insufficientBalance &&
        quote !== undefined &&
        quote > 0n &&
        swapState.status !== "pending";

    return (
        <div className="arc-card p-5">
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-medium text-arc-text-muted">Swap</h2>
                <button type="button"
                    onClick={() => setShowSettings((s) => !s)}
                    className="rounded-md p-1 text-arc-text-muted hover:bg-arc-surface hover:text-arc-text"
                    aria-label="Slippage settings"
                >
                    <Settings2 className="h-4 w-4" />
                </button>
            </div>

            {showSettings && (
                <div className="mb-4 rounded-lg border border-arc-border bg-arc-bg p-3 text-xs">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-arc-text-muted">Slippage tolerance</span>
                        <span className="font-medium">{(slippageBps / 100).toFixed(2)}%</span>
                    </div>
                    <input
                        aria-label="Slippage tolerance"
                        type="range"
                        min={10}
                        max={500}
                        step={10}
                        value={slippageBps}
                        onChange={(e) => setSlippageBps(Number(e.target.value))}
                        className="arc-slider w-full"
                    />
                </div>
            )}

            <AmountInput
                label="From"
                value={amountIn}
                onChange={setAmountIn}
                symbol={inputSymbol}
                image={direction === "sell" ? tokenImage : undefined}
                balanceLabel={`Balance: ${Number(formatUnits(balance, inputDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })}`}
                onMax={() => setAmountIn(formatUnits(balance, inputDecimals))}
            />

            <div className="my-2 flex justify-center">
                <button type="button"
                    onClick={() => {
                        setDirection((d) => (d === "buy" ? "sell" : "buy"));
                        setAmountIn("");
                        setQuote(undefined);
                    }}
                    className="rounded-lg border border-arc-border bg-arc-surface p-2 hover:border-arc-primary/40"
                    aria-label="Flip direction"
                >
                    <ArrowDownUp className="h-4 w-4" />
                </button>
            </div>

            <div className="rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-3">
                <div className="mb-1 text-xs text-arc-text-muted">To (estimated)</div>
                <div className="flex items-center justify-between">
                    <div className="text-2xl font-semibold">
                        {quote !== undefined
                            ? Number(formatUnits(quote, outputDecimals)).toLocaleString(undefined, {
                                  maximumFractionDigits: outputDecimals === 6 ? 4 : 6,
                              })
                            : quoteLoading
                              ? "..."
                              : "0"}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                        {direction === "buy" && tokenImage ? (
                            <TokenIcon image={tokenImage} symbol={outputSymbol} size={24} />
                        ) : null}
                        <span className="font-medium">{outputSymbol}</span>
                    </div>
                </div>
            </div>

            {quote !== undefined && quote > 0n && (
                <div className="mt-3 space-y-1 text-xs text-arc-text-muted">
                    <div className="flex justify-between">
                        <span>Min received ({(slippageBps / 100).toFixed(2)}% slippage)</span>
                        <span>
                            {Number(formatUnits(minAmountOut, outputDecimals)).toLocaleString(undefined, {
                                maximumFractionDigits: outputDecimals === 6 ? 4 : 6,
                            })}{" "}
                            {outputSymbol}
                        </span>
                    </div>
                </div>
            )}

            {quoteError && (
                <div className="mt-3 rounded-lg border border-arc-danger/40 bg-arc-danger/10 px-3 py-2 text-xs text-arc-danger">
                    Quote failed: {quoteError.slice(0, 120)}
                </div>
            )}

            <button type="button"
                onClick={onSwap}
                disabled={!canSwap}
                className={cn(
                    "mt-4 w-full rounded-xl bg-arc-primary px-4 py-3 text-sm font-medium text-white transition hover:bg-arc-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
                )}
            >
                {!isConnected
                    ? "Connect wallet"
                    : insufficientBalance
                      ? `Insufficient ${inputSymbol}`
                      : direction === "buy"
                        ? `Buy ${outputSymbol}`
                        : `Sell ${inputSymbol}`}
            </button>

            <TxStatus state={swapState} className="mt-3" />
        </div>
    );
}

// silence unused-var lint
void formatUSDC;
