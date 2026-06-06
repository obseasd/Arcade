"use client";

import { ArrowRight, Info } from "lucide-react";
import { formatUnits } from "viem";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { cn } from "@/lib/utils";

interface TokenMeta {
    symbol: string;
    decimals: number;
}

interface Props {
    /** "v2" surfaces LP output, "v3" surfaces liquidity + amount0/amount1. */
    variant: "v2" | "v3";
    tokenIn: TokenMeta;
    tokenOther: TokenMeta;
    amountIn: bigint;
    /** Portion of amountIn that will go through the swap. */
    swapAmount: bigint;
    /** Estimated tokenOther output of that swap. */
    expectedOut: bigint;
    /** V2 only: expected LP minted before slippage. */
    expectedLp?: bigint;
    /** V3 only: expected raw liquidity (uint128) units. */
    expectedLiquidity?: bigint;
    /** V3 only: expected amount0 / amount1 actually consumed by mint. */
    expectedAmount0?: bigint;
    expectedAmount1?: bigint;
    /** Active slippage tolerance, bps. */
    slippageBps: number;
}

/**
 * Pre-sign breakdown panel. Both V2 and V3 single-asset zaps render this
 * above the submit button so the user can read swap leg + expected mint
 * before signing. Replaces the black-box 'Zap into pool' UX flagged in the
 * 2026-06-06 audit (improvement #5).
 *
 * Format mirrors HyperSwap's preview: a swap leg with an arrow, an add-
 * liquidity row with both legs, and the receipt (LP or liquidity). All
 * numbers are rendered with token decimals so the user sees the same
 * units they typed.
 */
export function ZapBreakdownPanel({
    variant,
    tokenIn,
    tokenOther,
    amountIn,
    swapAmount,
    expectedOut,
    expectedLp,
    expectedLiquidity,
    expectedAmount0,
    expectedAmount1,
    slippageBps,
}: Props) {
    if (amountIn === 0n || swapAmount === 0n || expectedOut === 0n) {
        return (
            <div className="rounded-xl border border-arc-border bg-white/[0.015] p-3 text-xs text-arc-text-faint">
                Enter an amount to see the zap breakdown.
            </div>
        );
    }
    const remainingIn = amountIn > swapAmount ? amountIn - swapAmount : 0n;
    const slipPct = (slippageBps / 100).toFixed(2);

    return (
        <div className="rounded-xl border border-arc-border bg-white/[0.015] p-3">
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-arc-text-faint">
                <span>Zap breakdown</span>
                <span className="inline-flex items-center gap-1 normal-case text-arc-text-muted">
                    <Info className="h-3 w-3" />
                    {slipPct}% slippage
                </span>
            </div>

            {/* Swap leg */}
            <div className="rounded-lg border border-arc-border bg-black/15 p-2.5 text-xs">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-arc-text-faint">
                    Swap leg
                </div>
                <div className="flex items-center gap-2">
                    <TokenAmount amount={swapAmount} token={tokenIn} />
                    <ArrowRight className="h-3.5 w-3.5 text-arc-text-muted" />
                    <TokenAmount amount={expectedOut} token={tokenOther} />
                </div>
                <div className="mt-1 text-[10px] text-arc-text-faint">
                    Includes the pool&apos;s 0.30% swap fee. Dust returns to your wallet.
                </div>
            </div>

            {/* Add liquidity */}
            <div className="mt-2 rounded-lg border border-arc-border bg-black/15 p-2.5 text-xs">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-arc-text-faint">
                    {variant === "v3" ? "Mint position" : "Add liquidity"}
                </div>
                {variant === "v3" && expectedAmount0 !== undefined && expectedAmount1 !== undefined ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <TokenAmount
                            amount={
                                tokenIn.symbol.toLowerCase() < tokenOther.symbol.toLowerCase()
                                    ? expectedAmount0
                                    : expectedAmount1
                            }
                            token={tokenIn}
                        />
                        <span className="text-arc-text-faint">+</span>
                        <TokenAmount
                            amount={
                                tokenIn.symbol.toLowerCase() < tokenOther.symbol.toLowerCase()
                                    ? expectedAmount1
                                    : expectedAmount0
                            }
                            token={tokenOther}
                        />
                    </div>
                ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <TokenAmount amount={remainingIn} token={tokenIn} />
                        <span className="text-arc-text-faint">+</span>
                        <TokenAmount amount={expectedOut} token={tokenOther} />
                    </div>
                )}
            </div>

            {/* Receipt */}
            <div className="mt-2 flex items-center justify-between rounded-lg border border-arc-cta-hover/30 bg-arc-cta-hover/5 p-2.5 text-xs">
                <span className="text-arc-text-muted">
                    {variant === "v3" ? "Expected liquidity (L)" : "Expected LP"}
                </span>
                <span className="font-semibold tabular-nums text-arc-text">
                    {variant === "v3"
                        ? expectedLiquidity !== undefined
                            ? abbreviate(expectedLiquidity)
                            : "—"
                        : expectedLp !== undefined
                          ? fmtRaw(expectedLp, 18)
                          : "—"}
                </span>
            </div>
        </div>
    );
}

function TokenAmount({
    amount,
    token,
}: {
    amount: bigint;
    token: TokenMeta;
}) {
    return (
        <span className="inline-flex items-center gap-1.5">
            <TokenIcon symbol={token.symbol} size={16} />
            <span className={cn("tabular-nums", amount > 0n ? "text-arc-text" : "text-arc-text-faint")}>
                {fmtRaw(amount, token.decimals)}
            </span>
            <span className="text-arc-text-muted">{token.symbol}</span>
        </span>
    );
}

function fmtRaw(raw: bigint, decimals: number): string {
    if (raw === 0n) return "0";
    const n = Number(formatUnits(raw, decimals));
    if (n < 0.0001) return "<0.0001";
    if (n < 1) return n.toFixed(6);
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function abbreviate(n: bigint): string {
    const v = Number(n);
    if (v < 1e3) return v.toString();
    if (v < 1e6) return (v / 1e3).toFixed(2) + "k";
    if (v < 1e9) return (v / 1e6).toFixed(2) + "M";
    if (v < 1e12) return (v / 1e9).toFixed(2) + "B";
    return v.toExponential(2);
}
