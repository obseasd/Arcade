"use client";

import { Info, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import {
    V3_FACTORY_ABI,
    V3_NPM_ABI,
    V3_POOL_ABI,
} from "@/lib/abis/v3-npm";
import { ADDRESSES } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { TokenIcon } from "@/components/ui/TokenIcon";
import {
    clampTick,
    defaultTickSpacingForFee,
    encodeSqrtPriceX96,
    MAX_TICK,
    MIN_TICK,
    presetTickRange,
    priceToTickWithDecimals,
    type RangePreset,
    roundTickDown,
    roundTickUp,
    tickToPriceWithDecimals,
} from "@/lib/v3-math";
import { cn } from "@/lib/utils";

export interface V3Token {
    address: Address;
    symbol: string;
    decimals: number;
}

interface Props {
    tokenA: V3Token;
    tokenB: V3Token;
    feeBps: number; // 1 / 5 / 30 / 100 from CreatePoolModal
    slippageBps: number;
    deadlineMin: number;
}

/**
 * V3 concentrated-liquidity add surface. Sorts the user's tokens canonically
 * (token0 < token1 by address), reads the pool via factory.getPool, walks
 * tick spacing math for the range presets, and mints a new position via the
 * Arcade V3 NonfungiblePositionManager.
 *
 * When the pool doesn't exist yet, the submit path runs
 * createAndInitializePoolIfNecessary first with sqrtPriceX96 derived from the
 * user's min/max midpoint, then mints. Both happen in the same broadcast,
 * which mirrors how the canonical Uniswap UI handles fresh pools.
 */
export function V3AddLiquidity({
    tokenA,
    tokenB,
    feeBps,
    slippageBps,
    deadlineMin,
}: Props) {
    const router = useRouter();
    const { address: account } = useAccount();
    const publicClient = usePublicClient();
    const { writeContractAsync } = useWriteContract();

    const npmEnabled = ADDRESSES.v3PositionManager !== zeroAddress;
    const factoryEnabled = ADDRESSES.v3Factory !== zeroAddress;

    // V3 expects token0 < token1 by address. Order the user's selection.
    const [t0, t1] = useMemo(() => {
        return tokenA.address.toLowerCase() < tokenB.address.toLowerCase()
            ? [tokenA, tokenB]
            : [tokenB, tokenA];
    }, [tokenA, tokenB]);

    // V3 fee tier in pip (1bp = 100 pip; UI fee=30 means 0.30% = 3000 pip).
    const feePip = feeBps * 100;

    const poolAddrQ = useReadContract({
        address: ADDRESSES.v3Factory,
        abi: V3_FACTORY_ABI,
        functionName: "getPool",
        args: [t0.address, t1.address, feePip],
        query: { enabled: factoryEnabled },
    });
    const pool = poolAddrQ.data as Address | undefined;
    const hasPool = !!pool && pool !== zeroAddress;

    const slot0Q = useReadContract({
        address: pool,
        abi: V3_POOL_ABI,
        functionName: "slot0",
        query: { enabled: hasPool },
    });
    const tickSpacingQ = useReadContract({
        address: pool,
        abi: V3_POOL_ABI,
        functionName: "tickSpacing",
        query: { enabled: hasPool },
    });
    const currentTick =
        slot0Q.data !== undefined
            ? Number(
                  (slot0Q.data as readonly [bigint, number, ...unknown[]])[1],
              )
            : 0;
    // Tick spacing comes from the on-chain pool when one exists; otherwise
    // we MUST fall back to the canonical fee->spacing map (see
    // defaultTickSpacingForFee). The previous "feeBps" fallback was wrong:
    // for fee=0.30% the pool uses spacing=60 but feeBps=30, so ticks ended
    // up at multiples of 30 and the mint reverted on (tick % spacing) inside
    // v3-pool. This was the root cause of every "fresh V3 mint reverts"
    // report.
    const tickSpacing =
        (tickSpacingQ.data as number | undefined) ?? defaultTickSpacingForFee(feePip);

    const [preset, setPreset] = useState<RangePreset>("wide");
    const [tickLower, setTickLower] = useState<number>(MIN_TICK);
    const [tickUpper, setTickUpper] = useState<number>(MAX_TICK);

    // Recompute ticks whenever the preset, current tick, or spacing changes.
    useEffect(() => {
        if (preset === "custom") return; // Custom = user controls min/max via the inputs below.
        const { tickLower: tl, tickUpper: tu } = presetTickRange(
            preset,
            currentTick,
            tickSpacing || 60,
        );
        setTickLower(tl);
        setTickUpper(tu);
    }, [preset, currentTick, tickSpacing]);

    const minPrice = useMemo(
        () => tickToPriceWithDecimals(tickLower, t0.decimals, t1.decimals),
        [tickLower, t0.decimals, t1.decimals],
    );
    const maxPrice = useMemo(
        () => tickToPriceWithDecimals(tickUpper, t0.decimals, t1.decimals),
        [tickUpper, t0.decimals, t1.decimals],
    );
    const currentPrice = useMemo(
        () => tickToPriceWithDecimals(currentTick, t0.decimals, t1.decimals),
        [currentTick, t0.decimals, t1.decimals],
    );

    const [amount0, setAmount0] = useState("");
    const [amount1, setAmount1] = useState("");

    const bal0 = useReadContract({
        address: t0.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });
    const bal1 = useReadContract({
        address: t1.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });

    const { ensureAllowance: approve0 } = useApproveIfNeeded(
        t0.address,
        ADDRESSES.v3PositionManager,
    );
    const { ensureAllowance: approve1 } = useApproveIfNeeded(
        t1.address,
        ADDRESSES.v3PositionManager,
    );

    const [submitting, setSubmitting] = useState(false);

    // Out-of-range single-sided logic only makes sense when a pool already
    // exists (we know the current tick). On a fresh pool the user is
    // SETTING the initial price via the midpoint of their range, so both
    // legs are always needed regardless of where the ticks sit relative to
    // the default tick=0.
    const inRange =
        hasPool && currentTick >= tickLower && currentTick < tickUpper;
    const belowRange = hasPool && currentTick < tickLower;
    const aboveRange = hasPool && currentTick >= tickUpper;

    // Validation guard. Multiple layers:
    //   - Wallet + NPM are wired.
    //   - Range is a non-degenerate window (tickLower < tickUpper). Catches
    //     the case where both Min and Max prices default to 0 and the tick
    //     math collapses them onto the same tick - the mint would revert
    //     with `TLU` ("ticks lower / upper") from v3-core.
    //   - Min and Max prices are strictly positive (a 0 price means the
    //     user hasn't typed anything; submitting that creates a malformed
    //     sqrtPriceX96 seed).
    //   - Fresh pool: BOTH legs are required because there is no current
    //     price to anchor a single-sided position; the initial sqrtPriceX96
    //     is derived from the midpoint of the user's range.
    //   - Existing pool: at least the non-disabled side is filled.
    const validRange = tickLower < tickUpper && minPrice > 0 && maxPrice > 0;
    const sufficientAmounts = hasPool
        ? (!aboveRange && !!amount0) || (!belowRange && !!amount1)
        : !!amount0 && !!amount1;

    // Balance guard: every typed amount must fit in the wallet, otherwise
    // we'd pay gas just to revert at the transferFrom step. parseUnits can
    // throw on garbage input - swallow that case and treat it as "not
    // enough" so the CTA stays disabled until the user types a valid number.
    const balance0Raw = (bal0.data as bigint | undefined) ?? 0n;
    const balance1Raw = (bal1.data as bigint | undefined) ?? 0n;
    const a0WouldUse = (() => {
        try {
            return amount0 ? parseUnits(amount0, t0.decimals) : 0n;
        } catch {
            return -1n;
        }
    })();
    const a1WouldUse = (() => {
        try {
            return amount1 ? parseUnits(amount1, t1.decimals) : 0n;
        } catch {
            return -1n;
        }
    })();
    const enoughBalance0 =
        aboveRange ? true : a0WouldUse >= 0n && a0WouldUse <= balance0Raw;
    const enoughBalance1 =
        belowRange ? true : a1WouldUse >= 0n && a1WouldUse <= balance1Raw;
    const enoughBalance = enoughBalance0 && enoughBalance1;

    const canSubmit =
        !!account &&
        npmEnabled &&
        !submitting &&
        validRange &&
        sufficientAmounts &&
        enoughBalance;

    async function onSubmit() {
        if (!account) return;
        try {
            setSubmitting(true);

            const a0Raw = amount0 ? parseUnits(amount0, t0.decimals) : 0n;
            const a1Raw = amount1 ? parseUnits(amount1, t1.decimals) : 0n;

            // For fresh pools, seed sqrtPriceX96 at the user's midpoint price
            // so the first mint defines a sane reference. Skipped when a pool
            // already exists - the NPM ignores the seed in that case.
            if (!hasPool) {
                const seedPrice = Math.sqrt(minPrice * maxPrice);
                const sqrtX96 = encodeSqrtPriceX96(
                    seedPrice * Math.pow(10, t1.decimals - t0.decimals),
                );
                await writeContractAsync({
                    address: ADDRESSES.v3PositionManager,
                    abi: V3_NPM_ABI,
                    functionName: "createAndInitializePoolIfNecessary",
                    args: [t0.address, t1.address, feePip, sqrtX96],
                });
                // Slot0 will update on next refetch.
                await poolAddrQ.refetch();
            }

            await Promise.all([
                a0Raw > 0n ? approve0(a0Raw) : Promise.resolve(),
                a1Raw > 0n ? approve1(a1Raw) : Promise.resolve(),
            ]);

            const slipDen = 10_000n - BigInt(slippageBps);
            const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMin * 60);

            // Wait for the createAndInit tx to land before the mint reads
            // slot0 - races have caused mint to read tick=0 from a not-yet-
            // initialized pool and revert with R (slot0 unlocked check).
            if (!hasPool) {
                // poolAddrQ.refetch happened above; nothing else to do here
                // but the explicit comment marks the boundary.
            }

            const hash = await writeContractAsync({
                address: ADDRESSES.v3PositionManager,
                abi: V3_NPM_ABI,
                functionName: "mint",
                args: [
                    {
                        token0: t0.address,
                        token1: t1.address,
                        fee: feePip,
                        tickLower: tickLower,
                        tickUpper: tickUpper,
                        amount0Desired: a0Raw,
                        amount1Desired: a1Raw,
                        amount0Min: (a0Raw * slipDen) / 10_000n,
                        amount1Min: (a1Raw * slipDen) / 10_000n,
                        recipient: account,
                        deadline,
                    },
                ],
            });

            // Confirm the mint on-chain. If the receipt comes back reverted
            // (eg slippage trip on amount0Min / amount1Min, or a tick spacing
            // mismatch we somehow let through), throw so the catch handler
            // surfaces a real error instead of firing a success toast for a
            // tx that didn't do anything. Same pattern for the V2 and zap
            // submit paths.
            if (publicClient) {
                const receipt = await publicClient.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") {
                    throw new Error(
                        `Mint reverted on-chain (tx ${hash.slice(0, 10)}…). Common causes: slippage too tight, tick spacing mismatch, balances too low. Bump slippage in Settings or widen the range.`,
                    );
                }
            }

            pushToast({
                kind: "liquidity",
                token0: { address: t0.address, symbol: t0.symbol },
                token1: { address: t1.address, symbol: t1.symbol },
                amount0Formatted: amount0 || "0",
                amount1Formatted: amount1 || "0",
                lpFormatted: "1 NFT",
                poolHref: hasPool && pool ? `/pool/${pool}` : "/positions",
                explorerUrl: `${arcTestnet.blockExplorers?.default.url}/tx/${hash}`,
            });
            // Route to /positions?tab=concentrated so the new NFT is in view
            // without the user having to click the V3 tab themselves.
            router.push("/positions?tab=concentrated");
        } catch (e: unknown) {
            // Same multi-layer dig as the V2 path: reason -> shortMessage ->
            // details -> message. V3 mint reverts often surface as "TLU"
            // (tick lower / upper degenerate) or "AS" (pool not initialised)
            // which are useless without the full reason chain.
            const o = e as Record<string, unknown> | null;
            const reason =
                o && typeof o === "object"
                    ? ((o.cause as Record<string, unknown> | undefined)?.reason as string | undefined) ??
                      (o.shortMessage as string | undefined) ??
                      (o.details as string | undefined) ??
                      (o.message as string | undefined)
                    : undefined;
            const msg = reason || (e instanceof Error ? e.message : "Failed");
            pushToast({ kind: "error", title: "V3 mint failed", message: msg.slice(0, 200) });
        } finally {
            setSubmitting(false);
        }
    }

    if (!npmEnabled) {
        return (
            <div className="rounded-2xl border border-arc-warn/30 bg-arc-warn/10 p-4 text-sm text-arc-warn">
                <Info className="mr-1 inline h-4 w-4" />
                The V3 NonfungiblePositionManager hasn&apos;t been deployed yet.
                Run the DeployArcadeV3PositionManager script and set
                NEXT_PUBLIC_V3_NPM_ADDRESS to enable Concentrated Liquidity adds.
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Range presets */}
            <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-arc-text-muted">
                    Price range
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {(
                        [
                            { key: "max", label: "Max Range (±100%)" },
                            { key: "passive", label: "Passive (±50%)" },
                            { key: "wide", label: "Wide (±25%)" },
                            { key: "narrow", label: "Narrow (±5%)" },
                            { key: "aggressive", label: "Aggressive (±1%)" },
                        ] as { key: RangePreset; label: string }[]
                    ).map((p) => (
                        <button
                            key={p.key}
                            onClick={() => setPreset(p.key)}
                            className={cn(
                                "rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors",
                                preset === p.key
                                    ? "border-arc-cta-hover bg-arc-cta-hover/15 text-arc-text"
                                    : "border-arc-border bg-black/15 text-arc-text-muted hover:text-arc-text",
                            )}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Chart placeholder - swap with real liquidity histogram when
                ArcLens ships tickHistory. */}
            <div className="flex h-48 items-center justify-center rounded-2xl border border-arc-border bg-black/25 text-sm text-arc-text-muted backdrop-blur-xl">
                Liquidity distribution chart ships with ArcLens.
            </div>

            {/* Min / Max price inputs */}
            <div className="grid grid-cols-2 gap-3">
                <PriceInput
                    label="Min Price"
                    pricePerPair={`${t1.symbol} per ${t0.symbol}`}
                    value={minPrice}
                    onChange={(v) => {
                        setPreset("custom");
                        const t = priceToTickWithDecimals(
                            v,
                            t0.decimals,
                            t1.decimals,
                        );
                        setTickLower(roundTickDown(clampTick(t), tickSpacing || 60));
                    }}
                />
                <PriceInput
                    label="Max Price"
                    pricePerPair={`${t1.symbol} per ${t0.symbol}`}
                    value={maxPrice}
                    onChange={(v) => {
                        setPreset("custom");
                        const t = priceToTickWithDecimals(
                            v,
                            t0.decimals,
                            t1.decimals,
                        );
                        setTickUpper(roundTickUp(clampTick(t), tickSpacing || 60));
                    }}
                />
            </div>

            {hasPool && (
                <div className="rounded-xl border border-arc-border bg-arc-bg-elevated/50 p-3 text-xs text-arc-text-muted">
                    Current price: <span className="font-semibold text-arc-text tabular-nums">{currentPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span> {t1.symbol}/{t0.symbol}
                    {!inRange && (
                        <span className="ml-2 rounded-md bg-arc-warn/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-arc-warn">
                            out of range — single-sided
                        </span>
                    )}
                </div>
            )}
            {!hasPool && (
                <div className="rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-3 text-xs text-arc-warn">
                    Pool doesn&apos;t exist yet. Submitting will create it via
                    createAndInitializePoolIfNecessary with the midpoint of
                    your range as the seed price.
                </div>
            )}

            {/* Token inputs */}
            <V3TokenInput
                label={`Token 1 (${t0.symbol})`}
                token={t0}
                value={amount0}
                onChange={setAmount0}
                balance={bal0.data as bigint | undefined}
                disabled={aboveRange}
                disabledReason="Above range — only Token 2 is needed"
            />
            <div className="flex justify-center">
                <div className="-my-2 rounded-xl border border-arc-border bg-arc-bg-elevated p-2">
                    <Plus className="h-4 w-4 text-arc-text-muted" />
                </div>
            </div>
            <V3TokenInput
                label={`Token 2 (${t1.symbol})`}
                token={t1}
                value={amount1}
                onChange={setAmount1}
                balance={bal1.data as bigint | undefined}
                disabled={belowRange}
                disabledReason="Below range — only Token 1 is needed"
            />

            <button
                onClick={onSubmit}
                disabled={!canSubmit}
                className={cn(
                    "mt-2 w-full rounded-2xl py-3.5 text-base font-semibold transition-colors",
                    canSubmit
                        ? "bg-arc-cta text-white hover:bg-arc-cta-hover"
                        : "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted",
                )}
            >
                {!account
                    ? "Connect wallet"
                    : submitting
                      ? hasPool
                          ? "Minting position…"
                          : "Initialising pool + minting…"
                      : !validRange
                        ? "Set a valid price range"
                        : !sufficientAmounts
                          ? hasPool
                              ? "Enter an amount"
                              : "Enter both amounts"
                          : !enoughBalance0
                            ? `Insufficient ${t0.symbol} balance`
                            : !enoughBalance1
                              ? `Insufficient ${t1.symbol} balance`
                              : hasPool
                                ? "Add concentrated liquidity"
                                : "Create pool + add liquidity"}
            </button>
        </div>
    );
}

function PriceInput({
    label,
    value,
    onChange,
    pricePerPair,
}: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    pricePerPair: string;
}) {
    const [text, setText] = useState(value.toFixed(6));
    useEffect(() => setText(value === 0 || !isFinite(value) ? "0" : value.toFixed(6)), [value]);
    return (
        <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-3">
            <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">{label}</div>
            <input
                type="text"
                inputMode="decimal"
                value={text}
                onChange={(e) => {
                    const clean = e.target.value.replace(/[^0-9.]/g, "");
                    setText(clean);
                    const n = Number(clean);
                    if (!isFinite(n) || n <= 0) return;
                    onChange(n);
                }}
                className="mt-1 w-full bg-transparent text-2xl font-semibold tabular-nums text-arc-text outline-none"
            />
            <div className="mt-1 text-[10px] text-arc-text-muted">{pricePerPair}</div>
        </div>
    );
}

function V3TokenInput({
    label,
    token,
    value,
    onChange,
    balance,
    disabled,
    disabledReason,
}: {
    label: string;
    token: V3Token;
    value: string;
    onChange: (v: string) => void;
    balance?: bigint;
    disabled?: boolean;
    disabledReason?: string;
}) {
    const balText = useMemo(() => {
        if (!balance) return "0";
        const n = Number(formatUnits(balance, token.decimals));
        if (n === 0) return "0";
        if (n < 0.0001) return "<0.0001";
        return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }, [balance, token.decimals]);

    return (
        <div
            className={cn(
                "rounded-2xl border border-arc-border bg-white/[0.015] p-4",
                disabled && "opacity-60",
            )}
        >
            <div className="mb-2 flex items-center justify-between">
                <span className="text-sm text-arc-text-muted">{label}</span>
                <div className="flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-semibold">
                    <TokenIcon symbol={token.symbol} size={20} />
                    {token.symbol}
                </div>
            </div>
            <input
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                disabled={disabled}
                value={disabled ? "0" : value}
                onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
                className="w-full bg-transparent text-3xl font-semibold tabular-nums text-arc-text outline-none placeholder:text-arc-text-faint"
            />
            <div className="mt-1 flex items-center justify-between text-xs text-arc-text-muted">
                {disabled ? (
                    <span className="text-arc-warn">{disabledReason}</span>
                ) : (
                    <span>$-</span>
                )}
                <span className="inline-flex items-center gap-2">
                    {balText} {token.symbol}
                    {!disabled && (
                        <button
                            onClick={() =>
                                balance && onChange(formatUnits(balance, token.decimals))
                            }
                            className="rounded-md bg-arc-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-arc-text hover:bg-arc-surface-3"
                        >
                            MAX
                        </button>
                    )}
                </span>
            </div>
        </div>
    );
}
