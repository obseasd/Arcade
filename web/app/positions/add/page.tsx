"use client";

import {
    ArrowDownUp,
    ArrowLeft,
    ChevronDown,
    Info,
    Lock,
    Plus,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
    Address,
    erc20Abi,
    formatUnits,
    isAddress,
    parseUnits,
    zeroAddress,
} from "viem";
import {
    useAccount,
    usePublicClient,
    useReadContract,
    useWriteContract,
} from "wagmi";

import { FACTORY_ABI, PAIR_ABI, ROUTER_ABI, ZAP_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TransactionSettings } from "@/components/ui/TransactionSettings";
import { V3AddLiquidity } from "@/components/pool/V3AddLiquidity";
import { cn, formatLpBalance } from "@/lib/utils";

type Mode = "dual" | "single";
type PoolType = "amm" | "v3";

interface ResolvedToken {
    address: Address;
    symbol: string;
    name?: string;
    decimals: number;
}

/**
 * Suspense wrapper required for `useSearchParams` at the App Router level.
 */
export default function AddLiquidityPage() {
    return (
        <Suspense fallback={<PageSkeleton />}>
            <AddLiquidityInner />
        </Suspense>
    );
}

function PageSkeleton() {
    return (
        <div className="mx-auto max-w-2xl px-4 py-10">
            <div className="arc-card h-96 animate-pulse opacity-60" />
        </div>
    );
}

function AddLiquidityInner() {
    const sp = useSearchParams();
    const router = useRouter();
    const { address: account } = useAccount();
    const publicClient = usePublicClient();
    const { writeContractAsync } = useWriteContract();

    const poolType: PoolType = sp.get("type") === "v3" ? "v3" : "amm";
    const t0Param = sp.get("t0");
    const t1Param = sp.get("t1");
    const t0Addr = t0Param && isAddress(t0Param) ? (t0Param as Address) : ADDRESSES.usdc;
    const t1Addr = t1Param && isAddress(t1Param) ? (t1Param as Address) : zeroAddress;
    const feeBps = Number(sp.get("fee")) || 30;

    const tokenAResolved = useResolvedToken(t0Addr);
    const tokenB = useResolvedToken(t1Addr === zeroAddress ? undefined : t1Addr);
    // Token A always has a default (USDC) so this resolves on first paint.
    const tokenA: ResolvedToken =
        tokenAResolved ?? {
            address: ADDRESSES.usdc,
            symbol: "USDC",
            decimals: USDC_DECIMALS,
        };

    const [mode, setMode] = useState<Mode>("dual");
    const [amountA, setAmountA] = useState("");
    const [amountB, setAmountB] = useState("");
    // Which side did the user last type into. Drives which auto-quote effect
    // wins: editing A computes B from the V2 ratio, editing B computes A.
    // Without this both effects would race and clobber each other's value.
    const [lastEdited, setLastEdited] = useState<"A" | "B">("A");
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Default 0.5% (50 bps). The previous 0.1% was tight enough to trip
    // V3 mint slippage on normal rounding within the v3-pool.
    const [slippageBps, setSlippageBps] = useState(50);
    // Mirror of the popover's custom-input field. "" means a preset is active.
    const [slippageCustom, setSlippageCustom] = useState("");
    const [deadlineMin, setDeadlineMin] = useState(20);
    const [submitting, setSubmitting] = useState(false);

    // Discover the pair so we can lock the ratio and quote price + share.
    const pairAddr = useReadContract({
        address: ADDRESSES.factory,
        abi: FACTORY_ABI,
        functionName: "getPair",
        args: tokenB ? [tokenA.address, tokenB.address] : undefined,
        query: { enabled: !!tokenB },
    });
    const pair = pairAddr.data as Address | undefined;
    const hasPair = !!pair && pair !== zeroAddress;
    const reservesQ = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "getReserves",
        query: { enabled: hasPair },
    });
    const token0Q = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "token0",
        query: { enabled: hasPair },
    });
    const totalSupplyQ = useReadContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "totalSupply",
        query: { enabled: hasPair },
    });

    const balA = useReadContract({
        address: tokenA.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });
    const balB = useReadContract({
        address: tokenB?.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account && !!tokenB },
    });

    // V2 ratio auto-quote. The pair's reserves fix the deposit ratio, so the
    // side the user didn't touch is computed from the side they did. Two
    // effects, one per direction, gated on lastEdited so they don't race.
    useEffect(() => {
        if (lastEdited !== "A") return;
        if (!tokenB || !reservesQ.data || !token0Q.data || !amountA) return;
        const [r0, r1] = reservesQ.data as [bigint, bigint, number];
        if (r0 === 0n || r1 === 0n) return;
        try {
            const aRaw = parseUnits(amountA, tokenA.decimals);
            const isAFirst =
                (token0Q.data as Address).toLowerCase() === tokenA.address.toLowerCase();
            const [reserveA, reserveB] = isAFirst ? [r0, r1] : [r1, r0];
            if (reserveA === 0n) return;
            const bRaw = (aRaw * reserveB) / reserveA;
            setAmountB(formatUnits(bRaw, tokenB.decimals));
        } catch {
            /* ignore parse errors while typing */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [amountA, reservesQ.data, token0Q.data, tokenA.decimals, tokenB?.decimals, lastEdited]);

    useEffect(() => {
        if (lastEdited !== "B") return;
        if (!tokenB || !reservesQ.data || !token0Q.data || !amountB) return;
        const [r0, r1] = reservesQ.data as [bigint, bigint, number];
        if (r0 === 0n || r1 === 0n) return;
        try {
            const bRaw = parseUnits(amountB, tokenB.decimals);
            const isAFirst =
                (token0Q.data as Address).toLowerCase() === tokenA.address.toLowerCase();
            const [reserveA, reserveB] = isAFirst ? [r0, r1] : [r1, r0];
            if (reserveB === 0n) return;
            const aRaw = (bRaw * reserveA) / reserveB;
            setAmountA(formatUnits(aRaw, tokenA.decimals));
        } catch {
            /* ignore parse errors while typing */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [amountB, reservesQ.data, token0Q.data, tokenA.decimals, tokenB?.decimals, lastEdited]);

    const { ensureAllowance: approveA } = useApproveIfNeeded(
        tokenA.address,
        ADDRESSES.router,
    );
    const { ensureAllowance: approveB } = useApproveIfNeeded(
        tokenB?.address,
        ADDRESSES.router,
    );
    // Zap path uses its own approval target.
    const { ensureAllowance: approveAForZap } = useApproveIfNeeded(
        tokenA.address,
        ADDRESSES.v2Zap,
    );
    const zapEnabled = ADDRESSES.v2Zap !== zeroAddress;

    // Live preview of the zap split + LP output. Only fires when the user has
    // typed an amount, the pair exists, and zap is deployed.
    const zapAmountIn = useMemo(() => {
        if (!tokenB || !amountA || mode !== "single") return 0n;
        try {
            return parseUnits(amountA, tokenA.decimals);
        } catch {
            return 0n;
        }
    }, [amountA, tokenA.decimals, tokenB, mode]);

    const zapQuoteQ = useReadContract({
        address: ADDRESSES.v2Zap,
        abi: ZAP_ABI,
        functionName: "quoteZapIn",
        args: tokenB && zapAmountIn > 0n
            ? [tokenA.address, zapAmountIn, tokenB.address]
            : undefined,
        query: { enabled: zapEnabled && !!tokenB && zapAmountIn > 0n && hasPair },
    });
    const zapQuote = zapQuoteQ.data as
        | readonly [bigint, bigint, bigint]
        | undefined;

    const { pricePerA, pricePerB, sharePct } = usePoolEstimates({
        amountA,
        amountB,
        tokenA,
        tokenB,
        reserves: reservesQ.data as [bigint, bigint, number] | undefined,
        token0: token0Q.data as Address | undefined,
        totalSupply: totalSupplyQ.data as bigint | undefined,
    });

    const canSubmit = useMemo(() => {
        if (!account || !tokenB || !amountA || submitting) return false;
        if (mode === "dual") return !!amountB;
        // Single Asset: needs zap deployed AND an existing pair to swap through.
        return zapEnabled && hasPair;
    }, [account, tokenB, amountA, amountB, submitting, mode, zapEnabled, hasPair]);

    async function onSubmit() {
        if (!account || !tokenB) return;
        try {
            setSubmitting(true);
            const aRaw = parseUnits(amountA, tokenA.decimals);
            // Audit low [7]: hard clamp slip bps at submit time too in case
            // a fat-finger somehow lands a value the UI didn't catch. We refuse
            // anything outside [1, 5000] (= [0.01%, 50%]).
            const safeSlipBps = Math.min(5000, Math.max(1, slippageBps));
            const slipDen = 10_000n - BigInt(safeSlipBps);
            const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMin * 60);

            let hash: `0x${string}`;
            if (mode === "single") {
                // Single-asset zap: approve the zap helper and submit zapIn.
                // amountLpMin uses the quote with the user's slippage tolerance
                // applied so a swap-side surprise reverts before LP mint.
                await approveAForZap(aRaw);
                const lpMin =
                    zapQuote && zapQuote[2] > 0n
                        ? (zapQuote[2] * slipDen) / 10_000n
                        : 0n;
                hash = await writeContractAsync({
                    address: ADDRESSES.v2Zap,
                    abi: ZAP_ABI,
                    functionName: "zapIn",
                    args: [
                        tokenA.address,
                        aRaw,
                        tokenB.address,
                        lpMin,
                        account,
                        deadline,
                    ],
                });
            } else {
                const bRaw = parseUnits(amountB, tokenB.decimals);
                await Promise.all([approveA(aRaw), approveB(bRaw)]);
                hash = await writeContractAsync({
                    address: ADDRESSES.router,
                    abi: ROUTER_ABI,
                    functionName: "addLiquidity",
                    args: [
                        tokenA.address,
                        tokenB.address,
                        aRaw,
                        bRaw,
                        (aRaw * slipDen) / 10_000n,
                        (bRaw * slipDen) / 10_000n,
                        account,
                        deadline,
                    ],
                });
            }

            // Wait for the tx + read the LP balance afterwards so the toast can
            // surface the actual receipt amount. Check receipt.status BEFORE
            // touching post-success state — waitForTransactionReceipt returns
            // the receipt for both successful and reverted txs, so we have to
            // gate explicitly or the success toast fires on a no-op revert.
            let lpFormatted = "—";
            if (publicClient) {
                const receipt = await publicClient.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") {
                    throw new Error(
                        `${mode === "single" ? "Zap" : "Add liquidity"} reverted on-chain (tx ${hash.slice(0, 10)}…). Likely causes: pool balance moved between read and exec, slippage too tight, or the USDC blocklist precompile fired on Arc — try bumping slippage in Settings.`,
                    );
                }
                if (pair && pair !== zeroAddress) {
                    try {
                        const lp = (await publicClient.readContract({
                            address: pair,
                            abi: PAIR_ABI,
                            functionName: "balanceOf",
                            args: [account],
                        })) as bigint;
                        lpFormatted = formatLpBalance(lp);
                    } catch {
                        /* ignore - first-LP read can race the receipt */
                    }
                } else {
                    // First-LP path - pair address was zero before, refetch and
                    // try again so the toast has a number.
                    await pairAddr.refetch();
                }
            }

            pushToast({
                kind: "liquidity",
                token0: { address: tokenA.address, symbol: tokenA.symbol },
                token1: { address: tokenB.address, symbol: tokenB.symbol },
                amount0Formatted: amountA,
                amount1Formatted: amountB,
                lpFormatted,
                // Route the toast's "View pool" link to the pool detail page if
                // we know the pair address, else /positions as a graceful fallback.
                poolHref:
                    pair && pair !== zeroAddress ? `/pool/${pair}` : "/positions",
                explorerUrl: `${arcTestnet.blockExplorers?.default.url}/tx/${hash}`,
            });
            // Drop the user on the pool detail page (or /positions when we still
            // need to refetch the pair address after a first-LP add).
            router.push(
                pair && pair !== zeroAddress ? `/pool/${pair}` : "/positions",
            );
        } catch (e: unknown) {
            // Build the most informative error message we can: prefer viem's
            // ContractFunctionRevertedError reason, fall back to shortMessage,
            // then any details/data field, then Error.message. Without this
            // chain the toast tends to read "Failed" for chain-side reverts
            // (zap path on Arc loves to revert with a precompile message
            // buried two levels deep).
            const o = e as Record<string, unknown> | null;
            const reason =
                o && typeof o === "object"
                    ? ((o.cause as Record<string, unknown> | undefined)?.reason as string | undefined) ??
                      (o.shortMessage as string | undefined) ??
                      (o.details as string | undefined) ??
                      (o.message as string | undefined)
                    : undefined;
            const msg = reason || (e instanceof Error ? e.message : "Failed");
            const title =
                mode === "single" ? "Zap failed" : "Liquidity add failed";
            pushToast({ kind: "error", title, message: msg.slice(0, 200) });
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
            <Link
                href="/positions"
                className="mb-3 inline-flex items-center gap-1.5 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" />
                Back
            </Link>

            {/* Pair header card. The relative+z-30 ensures the embedded
                TransactionSettings popover (z-50 inside) paints above the
                sibling main card below, whose backdrop-blur creates its own
                stacking context. */}
            <div className="arc-card relative z-30 mb-3 flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                    <div className="flex -space-x-2">
                        <TokenIcon symbol={tokenA.symbol} size={36} />
                        <TokenIcon symbol={tokenB?.symbol} size={36} />
                    </div>
                    <div>
                        <div className="text-base font-semibold">
                            {tokenA.symbol} / {tokenB?.symbol ?? "?"}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                            <span
                                className={cn(
                                    "rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
                                    poolType === "v3"
                                        ? "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover"
                                        : "border-cyan-400/40 bg-cyan-400/10 text-cyan-400",
                                )}
                            >
                                {poolType === "v3" ? "v3" : "v2"}
                            </span>
                            <span className="rounded-md border border-arc-success/40 bg-arc-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-arc-success">
                                {(feeBps / 100).toFixed(2)}%
                            </span>
                        </div>
                    </div>
                </div>
                <TransactionSettings
                    open={settingsOpen}
                    onToggle={() => setSettingsOpen((v) => !v)}
                    onClose={() => setSettingsOpen(false)}
                    slippageBps={slippageBps}
                    slippageCustom={slippageCustom}
                    onPreset={(bps) => {
                        setSlippageBps(bps);
                        setSlippageCustom("");
                    }}
                    onCustom={(raw) => {
                        // Clamp the custom field to [1 bp, 5000 bps]
                        // (audit low [7]) so a typo can't sign a 100% min.
                        // Keep the raw string in state so the input doesn't
                        // re-render the typed value out from under the user.
                        const clean = raw.replace(/[^0-9.]/g, "");
                        setSlippageCustom(clean);
                        const n = Number(clean);
                        if (!Number.isFinite(n) || n <= 0) return;
                        const bps = Math.min(5000, Math.max(1, Math.round(n * 100)));
                        setSlippageBps(bps);
                    }}
                    deadlineMin={deadlineMin}
                    onDeadlineChange={setDeadlineMin}
                />
            </div>

            {/* Main add-liquidity card */}
            <div className="arc-card p-4 sm:p-5">
                {/* For V3 the whole form is concentrated-liquidity (range + dual
                    legs) and rendered by the dedicated component. The V2 dual/
                    single zap surface only applies to type=amm. */}
                {poolType === "v3" && tokenB ? (
                    <V3AddLiquidity
                        tokenA={{
                            address: tokenA.address,
                            symbol: tokenA.symbol,
                            decimals: tokenA.decimals,
                        }}
                        tokenB={{
                            address: tokenB.address,
                            symbol: tokenB.symbol,
                            decimals: tokenB.decimals,
                        }}
                        feeBps={feeBps}
                        slippageBps={slippageBps}
                        deadlineMin={deadlineMin}
                    />
                ) : (
                <>
                {/* Dual / Single tabs */}
                <div className="mb-3 flex items-center gap-4 text-sm">
                    <ModeTab active={mode === "dual"} onClick={() => setMode("dual")}>
                        Dual Token
                    </ModeTab>
                    <ModeTab
                        active={mode === "single"}
                        onClick={() => setMode("single")}
                        // Show the "Soon" pill only when the zap helper hasn't
                        // been deployed in this env (frontend off-switch).
                        soon={!zapEnabled}
                    >
                        Single Asset
                    </ModeTab>
                </div>

                {/* Token 1 input */}
                <TokenInput
                    label="Token 1"
                    token={tokenA}
                    value={amountA}
                    onChange={(v) => {
                        setLastEdited("A");
                        setAmountA(v);
                    }}
                    balance={balA.data as bigint | undefined}
                />

                {/* Centerpiece: a "+" cross on Dual Token (legs are SUMMED
                    into the LP), swap arrows on Single Asset (flip lets the
                    user pick which side they're zapping IN from). */}
                <div className="relative flex justify-center">
                    {mode === "single" ? (
                        <button
                            onClick={() => {
                                if (!tokenB) return;
                                const params = new URLSearchParams(sp.toString());
                                params.set("t0", tokenB.address);
                                params.set("t1", tokenA.address);
                                router.replace(`/positions/add?${params.toString()}`);
                                setAmountA("");
                                setAmountB("");
                            }}
                            title="Flip zap direction"
                            className="-my-2 rounded-xl border border-arc-border bg-arc-bg-elevated p-2 transition-colors hover:bg-white/5"
                        >
                            <ArrowDownUp className="h-4 w-4 text-arc-text" />
                        </button>
                    ) : (
                        <div className="-my-2 rounded-xl border border-arc-border bg-arc-bg-elevated p-2">
                            <Plus className="h-4 w-4 text-arc-text-muted" />
                        </div>
                    )}
                </div>

                {/* Token 2 input or locked field */}
                {mode === "dual" ? (
                    <TokenInput
                        label="Token 2"
                        token={tokenB}
                        value={amountB}
                        onChange={(v) => {
                            setLastEdited("B");
                            setAmountB(v);
                        }}
                        balance={balB.data as bigint | undefined}
                    />
                ) : (
                    <LockedField
                        label="Token 2"
                        token={tokenB}
                        // Surface the zap quote (other-side amount) so the
                        // locked field still shows what's actually heading
                        // into the pair.
                        previewAmount={
                            tokenB && zapQuote && zapQuote[1] > 0n
                                ? formatUnits(zapQuote[1], tokenB.decimals)
                                : undefined
                        }
                    />
                )}

                {/* Prices + pool share */}
                <div className="mt-4 rounded-2xl border border-arc-border bg-black/25 p-4 backdrop-blur-xl">
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-arc-text-muted">
                        Prices and pool share
                    </div>
                    {/* Share of pool sits between the two ratio stats so the
                        eye lands on the user-relevant number first. */}
                    <div className="grid grid-cols-3 gap-2 text-center">
                        <Stat
                            value={pricePerA ?? "—"}
                            label={`${tokenB?.symbol ?? "?"} per ${tokenA.symbol}`}
                        />
                        <Stat
                            value={sharePct ?? "0%"}
                            label="Share of Pool"
                        />
                        <Stat
                            value={pricePerB ?? "—"}
                            label={`${tokenA.symbol} per ${tokenB?.symbol ?? "?"}`}
                        />
                    </div>
                </div>

                {!hasPair && tokenB && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-3 text-xs text-arc-warn">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            No pool exists yet. You&apos;ll be the first liquidity provider
                            and the ratio you set defines the initial price.
                        </span>
                    </div>
                )}
                {mode === "single" && !zapEnabled && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-3 text-xs text-arc-warn">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            Single Asset Zap is queued to roll out as soon as
                            ArcadeV2Zap is wired into NEXT_PUBLIC_V2_ZAP_ADDRESS.
                            Use Dual Token in the meantime.
                        </span>
                    </div>
                )}
                {mode === "single" && zapEnabled && !hasPair && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-3 text-xs text-arc-warn">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            Single Asset Zap needs an existing pair to swap through.
                            Seed the pool with Dual Token first, then zap from there.
                        </span>
                    </div>
                )}

                <button
                    onClick={onSubmit}
                    disabled={!canSubmit}
                    className={cn(
                        "mt-4 w-full rounded-2xl py-3.5 text-base font-semibold transition-colors",
                        canSubmit
                            ? "bg-arc-cta text-white hover:bg-arc-cta-hover"
                            : "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted",
                    )}
                >
                    {!account
                        ? "Connect wallet"
                        : !tokenB
                          ? "Select a token"
                          : mode === "single" && !zapEnabled
                            ? "Single Asset Zap — coming soon"
                            : mode === "single" && !hasPair
                              ? "No pool to zap into yet"
                              : !amountA || (mode === "dual" && !amountB)
                                ? "Enter an amount"
                                : submitting
                                  ? "Adding liquidity…"
                                  : mode === "single"
                                    ? "Zap into pool"
                                    : "Add liquidity"}
                </button>
                </>
                )}
            </div>

        </div>
    );
}

function ModeTab({
    active,
    soon,
    onClick,
    children,
}: {
    active: boolean;
    soon?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "relative pb-1 text-sm font-semibold transition-colors",
                active
                    ? "text-arc-text after:absolute after:-bottom-1 after:left-0 after:right-0 after:h-[2px] after:rounded-full after:bg-arc-cta-hover"
                    : "text-arc-text-muted hover:text-arc-text",
            )}
        >
            {children}
            {soon && (
                <span className="ml-1.5 rounded-md border border-arc-border bg-arc-bg-elevated px-1.5 py-0.5 align-middle text-[9px] uppercase tracking-wider text-arc-text-muted">
                    Soon
                </span>
            )}
        </button>
    );
}

function TokenInput({
    label,
    token,
    value,
    onChange,
    balance,
}: {
    label: string;
    token: ResolvedToken | undefined;
    value: string;
    onChange: (v: string) => void;
    balance?: bigint;
}) {
    const balDisplay = useMemo(() => {
        if (!balance || !token) return "0";
        const n = Number(formatUnits(balance, token.decimals));
        if (n === 0) return "0";
        if (n < 0.0001) return "<0.0001";
        return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }, [balance, token]);
    return (
        <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-4">
            <div className="mb-2 flex items-center justify-between">
                <span className="text-sm text-arc-text-muted">{label}</span>
                <div className="flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-semibold">
                    <TokenIcon symbol={token?.symbol} size={20} />
                    {token?.symbol ?? "?"}
                    <ChevronDown className="h-3.5 w-3.5 text-arc-text-muted" />
                </div>
            </div>
            <input
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                value={value}
                onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
                className="w-full bg-transparent text-3xl font-semibold tabular-nums text-arc-text outline-none placeholder:text-arc-text-faint"
            />
            <div className="mt-1 flex items-center justify-between text-xs text-arc-text-muted">
                <span>$-</span>
                <span className="inline-flex items-center gap-2">
                    {balDisplay} {token?.symbol}
                    <button
                        onClick={() =>
                            balance && token && onChange(formatUnits(balance, token.decimals))
                        }
                        className="rounded-md bg-arc-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-arc-text hover:bg-arc-surface-3"
                    >
                        MAX
                    </button>
                </span>
            </div>
        </div>
    );
}

function LockedField({
    label,
    token,
    previewAmount,
}: {
    label: string;
    token: ResolvedToken | undefined;
    /** Optional zap quote so the locked field reads as "0 + arrow" until the
     *  user types a Token 1 amount, then flips to the live preview. */
    previewAmount?: string;
}) {
    const display = previewAmount
        ? Number(previewAmount).toLocaleString(undefined, {
              maximumFractionDigits: 6,
          })
        : "0";
    return (
        <div className="relative rounded-2xl border border-arc-border bg-white/[0.015] p-4">
            <div className="mb-2 flex items-center justify-between">
                <span className="text-sm text-arc-text-muted">{label}</span>
                <div className="flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-semibold opacity-70">
                    <TokenIcon symbol={token?.symbol} size={20} />
                    {token?.symbol ?? "?"}
                    <ChevronDown className="h-3.5 w-3.5 text-arc-text-muted" />
                </div>
            </div>
            <div className="text-3xl font-semibold tabular-nums text-arc-text-faint">
                {display}
            </div>
            <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-arc-text-muted">
                <Lock className="h-3 w-3" />
                {previewAmount
                    ? "auto-zapped via the pool"
                    : "locked in Single Asset Zap"}
            </div>
        </div>
    );
}

function Stat({ value, label }: { value: string; label: string }) {
    return (
        <div>
            <div className="text-sm font-semibold tabular-nums text-arc-text">{value}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wider text-arc-text-muted">
                {label}
            </div>
        </div>
    );
}

// -------------------------------------------------------------------
// hooks
// -------------------------------------------------------------------

function useResolvedToken(address: Address | undefined): ResolvedToken | undefined {
    const enabled = !!address && address !== zeroAddress;
    const symbolQ = useReadContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
        query: { enabled },
    });
    const nameQ = useReadContract({
        address,
        abi: erc20Abi,
        functionName: "name",
        query: { enabled },
    });
    const decimalsQ = useReadContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
        query: { enabled },
    });
    if (!address) return undefined;
    // USDC special-case: pin the symbol + decimals so this page renders right
    // away on first paint instead of waiting for the multicall fallback.
    if (address.toLowerCase() === ADDRESSES.usdc.toLowerCase()) {
        return {
            address,
            symbol: "USDC",
            name: "USD Coin",
            decimals: USDC_DECIMALS,
        };
    }
    return {
        address,
        symbol: (symbolQ.data as string | undefined) ?? "TOKEN",
        name: nameQ.data as string | undefined,
        decimals: (decimalsQ.data as number | undefined) ?? 18,
    };
}

function usePoolEstimates({
    amountA,
    amountB,
    tokenA,
    tokenB,
    reserves,
    token0,
    totalSupply,
}: {
    amountA: string;
    amountB: string;
    tokenA: ResolvedToken;
    tokenB: ResolvedToken | undefined;
    reserves?: [bigint, bigint, number];
    token0?: Address;
    totalSupply?: bigint;
}) {
    return useMemo(() => {
        if (!tokenB) return { pricePerA: undefined, pricePerB: undefined, sharePct: "0%" };
        // Pre-pair: price comes from the user-typed amounts; share = 100%.
        if (!reserves || (reserves[0] === 0n && reserves[1] === 0n)) {
            if (!amountA || !amountB) {
                return { pricePerA: "—", pricePerB: "—", sharePct: "100%" };
            }
            const aN = Number(amountA);
            const bN = Number(amountB);
            if (aN === 0 || bN === 0)
                return { pricePerA: "—", pricePerB: "—", sharePct: "100%" };
            return {
                pricePerA: (bN / aN).toLocaleString(undefined, { maximumFractionDigits: 6 }),
                pricePerB: (aN / bN).toLocaleString(undefined, { maximumFractionDigits: 6 }),
                sharePct: "100%",
            };
        }
        const [r0, r1] = reserves;
        const isAFirst = token0?.toLowerCase() === tokenA.address.toLowerCase();
        const [reserveA, reserveB] = isAFirst ? [r0, r1] : [r1, r0];
        const rA = Number(formatUnits(reserveA, tokenA.decimals));
        const rB = Number(formatUnits(reserveB, tokenB.decimals));
        const priceA = rA > 0 ? rB / rA : 0;
        const priceB = rB > 0 ? rA / rB : 0;

        let sharePct = "0%";
        if (amountA && totalSupply && totalSupply > 0n) {
            try {
                const aRaw = parseUnits(amountA, tokenA.decimals);
                const mintFraction = Number(aRaw) / (Number(reserveA) + Number(aRaw));
                sharePct = `${(mintFraction * 100).toFixed(2)}%`;
            } catch {
                /* ignore */
            }
        }

        return {
            pricePerA: priceA.toLocaleString(undefined, { maximumFractionDigits: 6 }),
            pricePerB: priceB.toLocaleString(undefined, { maximumFractionDigits: 6 }),
            sharePct,
        };
    }, [amountA, amountB, tokenA, tokenB, reserves, token0, totalSupply]);
}
