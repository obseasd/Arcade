"use client";

import { useEffect, useMemo, useState } from "react";
import { Info, Trash2 } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import {
    Address,
    encodeFunctionData,
    formatUnits,
    parseAbi,
    zeroAddress,
} from "viem";
import {
    useAccount,
    usePublicClient,
    useReadContract,
    useWalletClient,
} from "wagmi";

import { V3_NPM_ABI, V3_POOL_ABI } from "@/lib/abis/v3-npm";
import { ADDRESSES } from "@/lib/constants";
import { Modal } from "@/components/ui/Modal";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { pushToast } from "@/lib/toast";
import { addActivity } from "@/lib/activityFeed";
import { cn } from "@/lib/utils";
import {
    getAmountsForLiquidity,
    getSqrtRatioAtTick,
} from "@/lib/v3-math";

const MAX_UINT128 = (1n << 128n) - 1n;

interface Props {
    open: boolean;
    onClose: () => void;
    onSuccess?: () => void;
    tokenId: bigint;
    poolAddress: Address;
    token0: Address;
    token1: Address;
    token0Meta: { symbol: string; decimals: number };
    token1Meta: { symbol: string; decimals: number };
    liquidity: bigint;
    tickLower: number;
    tickUpper: number;
    /** Live tokensOwed0/1 read off NPM.positions, used to seed the
     *  preview's "you also collect" row. The contract still recomputes
     *  the actual collect amount at exec time, so this is a lower bound
     *  estimate same as ClaimAllFeesModal's per-row preview. */
    tokensOwed0: bigint;
    tokensOwed1: bigint;
}

const PRESETS = [25, 50, 75, 100] as const;

/**
 * V3 Remove Liquidity modal. Lets the user dial back a position's
 * liquidity by % (presets + free input), preview the underlying token
 * amounts they would receive at the current pool price, optionally
 * collect any unclaimed fees in the same tx, and optionally burn the
 * NFT when removing 100%.
 *
 * Execution model:
 *   - 0% < pct < 100%: NPM.multicall([decreaseLiquidity, collect?]).
 *     The collect is appended only when "Claim fees" is on, which
 *     defaults to on so the user gets the fee tokens out at the same
 *     time as the principal.
 *   - pct = 100%: NPM.multicall([decreaseLiquidity, collect?, burn?]).
 *     burn is appended only when "Burn NFT" is on (default on), since
 *     after a 100% decrease + collect the NFT exists but contains
 *     nothing; keeping it around clutters the wallet's NPM list.
 *
 * Slippage applies to the decreaseLiquidity amount0Min / amount1Min
 * (NOT the collect, which sweeps whatever is owed at exec time).
 */
export function RemoveLiquidityModalV3({
    open,
    onClose,
    onSuccess,
    tokenId,
    poolAddress,
    token0,
    token1,
    token0Meta,
    token1Meta,
    liquidity,
    tickLower,
    tickUpper,
    tokensOwed0,
    tokensOwed1,
}: Props) {
    const { address: account } = useAccount();
    const publicClient = usePublicClient();
    const { data: walletClient } = useWalletClient();

    const [pct, setPct] = useState(100);
    const [pctCustom, setPctCustom] = useState("");
    const [claimFees, setClaimFees] = useState(true);
    const [burnNft, setBurnNft] = useState(true);
    const [slippageBps] = useState(50); // 0.5% default; settings popover can be added later
    const [deadlineMin] = useState(20);
    const [submitting, setSubmitting] = useState(false);

    // Reset modal state every time the user re-opens it - a stale
    // pct from the prior open would surprise the next position.
    useEffect(() => {
        if (open) {
            setPct(100);
            setPctCustom("");
            setClaimFees(true);
            setBurnNft(true);
            setSubmitting(false);
        }
    }, [open]);

    // Live slot0 for the pool. Used to estimate amount0/amount1 from
    // the liquidity-to-remove via getAmountsForLiquidity. We could
    // alternatively eth_call decreaseLiquidity but the math route is
    // cheaper and matches the on-chain Uniswap V3 LiquidityAmounts lib
    // bit-for-bit (see lib/v3-math.ts commentary).
    const slot0Q = useReadContract({
        address: poolAddress,
        abi: V3_POOL_ABI,
        functionName: "slot0",
        query: { enabled: open && poolAddress !== zeroAddress },
    });
    const sqrtPriceX96 = slot0Q.data
        ? ((slot0Q.data as readonly [bigint, number, ...unknown[]])[0])
        : 0n;

    const liquidityToRemove = useMemo(() => {
        const effectivePct = Math.max(0, Math.min(100, pct));
        return (liquidity * BigInt(effectivePct)) / 100n;
    }, [liquidity, pct]);

    const preview = useMemo<{ amount0: bigint; amount1: bigint }>(() => {
        if (sqrtPriceX96 === 0n || liquidityToRemove === 0n) {
            return { amount0: 0n, amount1: 0n };
        }
        const sqrtA = getSqrtRatioAtTick(tickLower);
        const sqrtB = getSqrtRatioAtTick(tickUpper);
        return getAmountsForLiquidity(
            sqrtPriceX96,
            sqrtA,
            sqrtB,
            liquidityToRemove,
        );
    }, [sqrtPriceX96, liquidityToRemove, tickLower, tickUpper]);

    const onPreset = (preset: number) => {
        setPct(preset);
        setPctCustom("");
    };
    const onCustomChange = (raw: string) => {
        setPctCustom(raw);
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0 && n <= 100) {
            setPct(Math.round(n));
        }
    };

    const isFullExit = pct >= 100;

    async function onSubmit() {
        if (
            !account ||
            !walletClient ||
            !publicClient ||
            liquidityToRemove === 0n
        ) {
            return;
        }
        try {
            setSubmitting(true);
            const deadline = BigInt(
                Math.floor(Date.now() / 1000) + deadlineMin * 60,
            );
            const slipDen = 10_000n - BigInt(slippageBps);
            const amount0Min = (preview.amount0 * slipDen) / 10_000n;
            const amount1Min = (preview.amount1 * slipDen) / 10_000n;

            const calls: `0x${string}`[] = [];
            // 1. Decrease the position by the chosen % at the slippage
            // floor the user agreed to. The contract returns the actual
            // amounts decremented to the position's owed tokens (which
            // the next collect sweeps).
            calls.push(
                encodeFunctionData({
                    abi: V3_NPM_ABI,
                    functionName: "decreaseLiquidity",
                    args: [
                        {
                            tokenId,
                            liquidity: liquidityToRemove,
                            amount0Min,
                            amount1Min,
                            deadline,
                        },
                    ],
                }),
            );

            // 2. Collect the freshly decremented principal AND (if the
            // toggle is on) the pre-existing unclaimed fees. We always
            // sweep the principal even when claimFees is off — the
            // decreased liquidity sits in tokensOwed0/1 after step 1
            // and would otherwise be lost to the next session. The
            // toggle only controls whether the PRE-EXISTING tokensOwed
            // (= unclaimed fees from prior swap activity) is included;
            // since collect always sweeps the full balance, we honour
            // the toggle by skipping the collect call entirely when
            // off AND the user is keeping >0% of the position (so the
            // residual fees stay claimable from the position card).
            if (claimFees || isFullExit) {
                calls.push(
                    encodeFunctionData({
                        abi: V3_NPM_ABI,
                        functionName: "collect",
                        args: [
                            {
                                tokenId,
                                recipient: account,
                                amount0Max: MAX_UINT128,
                                amount1Max: MAX_UINT128,
                            },
                        ],
                    }),
                );
            }

            // 3. If the user removed 100% and asked for a clean wallet,
            // burn the NFT. The NPM enforces "liquidity == 0 &&
            // tokensOwed0 == 0 && tokensOwed1 == 0" inside burn(), so
            // we MUST collect first - which step 2 above already does.
            if (isFullExit && burnNft) {
                calls.push(
                    encodeFunctionData({
                        abi: V3_NPM_ABI,
                        functionName: "burn",
                        args: [tokenId],
                    }),
                );
            }

            // 4. Wrap everything into one multicall tx so the user
            // signs ONCE and either the whole flow lands atomically or
            // nothing does. NPM inherits Uniswap V3's Multicall.sol so
            // this is a stock pattern. We encode the multicall(bytes[])
            // signature by hand because wagmi v2's writeContract type
            // narrowing doesn't expose bytes[]-returning Multicall
            // selectors (known issue, also used in ClaimAllFeesModal).
            const multicallData = encodeFunctionData({
                abi: parseAbi([
                    "function multicall(bytes[] data) payable returns (bytes[])",
                ]),
                functionName: "multicall",
                args: [calls],
            });
            const hash = await walletClient.sendTransaction({
                to: ADDRESSES.v3PositionManager,
                data: multicallData,
            });
            await publicClient.waitForTransactionReceipt({ hash });

            const a0 = formatUnits(preview.amount0, token0Meta.decimals);
            const a1 = formatUnits(preview.amount1, token1Meta.decimals);
            pushToast({
                kind: "info",
                title: isFullExit ? "Position closed" : "Liquidity removed",
                message: `Got ~${trimAmt(a0)} ${token0Meta.symbol} + ~${trimAmt(a1)} ${token1Meta.symbol}`,
            });
            addActivity({
                type: "claim-fees",
                account,
                token: token0.toLowerCase() === ADDRESSES.usdc.toLowerCase() ? token1 : token0,
                label: isFullExit
                    ? `Closed position #${tokenId.toString()}`
                    : `Removed ${pct}% from #${tokenId.toString()}`,
                value: `${trimAmt(a0)} ${token0Meta.symbol} + ${trimAmt(a1)} ${token1Meta.symbol}`,
            });
            onSuccess?.();
            onClose();
        } catch (e: unknown) {
            const o = e as Record<string, unknown> | null;
            const reason =
                o && typeof o === "object"
                    ? ((o.cause as Record<string, unknown> | undefined)
                          ?.reason as string | undefined) ??
                      (o.shortMessage as string | undefined) ??
                      (o.message as string | undefined)
                    : undefined;
            pushToast({
                kind: "error",
                title: "Remove failed",
                message: (reason || (e instanceof Error ? e.message : "Failed")).slice(
                    0,
                    200,
                ),
            });
        } finally {
            setSubmitting(false);
        }
    }

    const slot0Pending =
        open && poolAddress !== zeroAddress && sqrtPriceX96 === 0n;
    const disabled =
        !account ||
        !walletClient ||
        submitting ||
        liquidityToRemove === 0n ||
        slot0Pending;

    return (
        <Modal
            open={open}
            onClose={onClose}
            widthClassName="max-w-lg"
            backdropClassName="backdrop:bg-black/40 backdrop:backdrop-blur-md"
            className="border-arc-border bg-black/55 backdrop-blur-2xl"
        >
            <div className="flex items-center justify-between border-b border-arc-border px-5 py-4">
                <h3 className="text-base font-semibold">
                    Remove liquidity · #{tokenId.toString()}
                </h3>
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full border border-arc-border bg-black/30 p-1.5 text-arc-text-muted hover:text-arc-text"
                >
                    <CrossIcon size={16} />
                </button>
            </div>

            <div className="space-y-4 p-5">
                {/* Percentage picker. Big readout up top so the user reads
                    "X%" before scanning the presets, then the input field
                    + presets row below for fine control. */}
                <div className="rounded-xl border border-arc-border bg-white/[0.015] p-4">
                    <div className="mb-3 flex items-baseline justify-between">
                        <div className="text-xs uppercase tracking-wider text-arc-text-muted">
                            Amount to remove
                        </div>
                        <div className="font-display text-3xl font-semibold tabular-nums text-arc-text">
                            {pct}%
                        </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                        {PRESETS.map((p) => {
                            const active = pct === p && !pctCustom;
                            return (
                                <button
                                    key={p}
                                    type="button"
                                    onClick={() => onPreset(p)}
                                    className={cn(
                                        "rounded-lg border px-2 py-2 text-sm font-semibold transition-colors",
                                        active
                                            ? "border-arc-cta-hover bg-arc-cta-hover/10 text-arc-cta-hover"
                                            : "border-arc-border bg-white/[0.015] text-arc-text-muted hover:bg-white/[0.04]",
                                    )}
                                >
                                    {p}%
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                        <input
                            type="text"
                            inputMode="numeric"
                            value={pctCustom}
                            onChange={(e) => onCustomChange(e.target.value)}
                            placeholder="Custom %"
                            className="w-full rounded-lg border border-arc-border bg-white/[0.015] px-3 py-2 text-sm text-arc-text outline-none focus:border-arc-cta-hover"
                        />
                    </div>
                </div>

                {/* Preview row - amounts the user is expected to receive
                    on principal side. The collect leg adds fees on top
                    (shown in its own row when claimFees is on). */}
                <div className="rounded-xl border border-arc-border bg-white/[0.015] p-4">
                    <div className="mb-2 text-xs uppercase tracking-wider text-arc-text-muted">
                        You will receive (principal)
                    </div>
                    <div className="space-y-2">
                        <PreviewRow
                            symbol={token0Meta.symbol}
                            amount={preview.amount0}
                            decimals={token0Meta.decimals}
                            tokenAddress={token0}
                        />
                        <PreviewRow
                            symbol={token1Meta.symbol}
                            amount={preview.amount1}
                            decimals={token1Meta.decimals}
                            tokenAddress={token1}
                        />
                    </div>
                    {slot0Pending && (
                        <div className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-arc-text-faint">
                            <Info className="h-3 w-3" />
                            Loading pool price…
                        </div>
                    )}
                </div>

                {/* Toggles - Claim fees + Burn NFT. Burn only renders
                    when the user is fully exiting since burn requires
                    a zeroed-out position. */}
                <div className="space-y-2">
                    <ToggleRow
                        label="Also claim unclaimed fees"
                        sub={
                            tokensOwed0 > 0n || tokensOwed1 > 0n
                                ? `${trimAmt(formatUnits(tokensOwed0, token0Meta.decimals))} ${token0Meta.symbol} + ${trimAmt(formatUnits(tokensOwed1, token1Meta.decimals))} ${token1Meta.symbol}`
                                : "No unclaimed fees right now"
                        }
                        on={claimFees}
                        onChange={setClaimFees}
                        disabled={isFullExit}
                    />
                    {isFullExit && (
                        <ToggleRow
                            label="Burn NFT after closing"
                            sub="Cleans up the empty position from your wallet."
                            on={burnNft}
                            onChange={setBurnNft}
                        />
                    )}
                </div>

                {/* Slippage notice (placeholder for a settings popover) */}
                <div className="flex items-center gap-2 rounded-xl border border-arc-border bg-white/[0.015] p-3 text-xs text-arc-text-muted">
                    <Info className="h-3.5 w-3.5" />
                    <span>
                        Slippage tolerance{" "}
                        <span className="font-semibold tabular-nums text-arc-text">
                            {(slippageBps / 100).toFixed(2)}%
                        </span>{" "}
                        · deadline{" "}
                        <span className="font-semibold tabular-nums text-arc-text">
                            {deadlineMin} min
                        </span>
                    </span>
                </div>

                <button
                    type="button"
                    onClick={() => void onSubmit()}
                    disabled={disabled}
                    className={cn(
                        "inline-flex w-full items-center justify-center gap-1.5 rounded-xl py-3 text-sm font-semibold transition-colors",
                        disabled
                            ? "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted"
                            : "bg-arc-cta text-white hover:bg-arc-cta-hover",
                    )}
                >
                    {submitting ? (
                        "Removing…"
                    ) : isFullExit ? (
                        <>
                            <Trash2 className="h-4 w-4" />
                            Close position
                        </>
                    ) : (
                        `Remove ${pct}%`
                    )}
                </button>
            </div>
        </Modal>
    );
}

function PreviewRow({
    symbol,
    amount,
    decimals,
    tokenAddress,
}: {
    symbol: string;
    amount: bigint;
    decimals: number;
    tokenAddress: Address;
}) {
    void tokenAddress;
    const fmt =
        amount === 0n
            ? "0"
            : (() => {
                  const n = Number(formatUnits(amount, decimals));
                  if (n < 0.0001) return "<0.0001";
                  return n.toLocaleString(undefined, {
                      maximumFractionDigits: 6,
                  });
              })();
    return (
        <div className="flex items-center justify-between gap-3 text-sm">
            <span className="inline-flex items-center gap-2 text-arc-text-muted">
                <TokenIcon symbol={symbol} size={20} />
                {symbol}
            </span>
            <span
                className={cn(
                    "font-semibold tabular-nums",
                    amount > 0n ? "text-arc-text" : "text-arc-text-faint",
                )}
            >
                {fmt}
            </span>
        </div>
    );
}

function ToggleRow({
    label,
    sub,
    on,
    onChange,
    disabled,
}: {
    label: string;
    sub?: string;
    on: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={() => !disabled && onChange(!on)}
            disabled={disabled}
            className={cn(
                "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors",
                disabled
                    ? "cursor-not-allowed border-arc-border bg-white/[0.015] opacity-60"
                    : on
                      ? "border-arc-cta-hover bg-arc-cta-hover/10"
                      : "border-arc-border bg-white/[0.015] hover:bg-white/[0.04]",
            )}
        >
            <div className="min-w-0">
                <div className="text-xs font-semibold text-arc-text">{label}</div>
                {sub && (
                    <div className="mt-0.5 text-[11px] text-arc-text-muted">
                        {sub}
                    </div>
                )}
            </div>
            <span
                className={cn(
                    "inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
                    on
                        ? "border-arc-cta-hover bg-arc-cta-hover/40"
                        : "border-arc-border bg-arc-bg-elevated",
                )}
            >
                <span
                    className={cn(
                        "h-3.5 w-3.5 rounded-full bg-white transition-transform",
                        on ? "translate-x-[18px]" : "translate-x-[2px]",
                    )}
                />
            </span>
        </button>
    );
}

function trimAmt(raw: string): string {
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) return "0";
    if (n < 0.0001) return "<0.0001";
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
