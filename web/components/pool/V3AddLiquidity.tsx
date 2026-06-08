"use client";

import { ArrowUpDown, Info, Lock, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import {
    V3_FACTORY_ABI,
    V3_NPM_ABI,
    V3_POOL_ABI,
} from "@/lib/abis/v3-npm";
import { V3_ZAP_ABI } from "@/lib/abis/v3-zap";
import { ADDRESSES } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { ZapBreakdownPanel } from "@/components/pool/ZapBreakdownPanel";
import {
    defaultTickSpacingForFee,
    encodeSqrtPriceX96,
    getAmountsForLiquidity,
    getLiquidityForAmounts,
    getSqrtRatioAtTick,
    isSqrtPriceInRange,
    MAX_TICK,
    MIN_TICK,
    nearestUsableTick,
    presetTickRange,
    priceToTickWithDecimals,
    quoteOtherAmount,
    type RangePreset,
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
    const zapEnabled = ADDRESSES.v3Zap !== zeroAddress;

    // Dual = both legs typed. Single = user provides one token, the zap
    // contract swaps half via the pool and mints a max-range position. Zap
    // tab is gated on the contract being wired AND a pool existing (zap
    // can't seed a fresh pool because there's no price to swap against).
    const [mode, setMode] = useState<"dual" | "single">("dual");
    const [zapTokenSide, setZapTokenSide] = useState<"0" | "1">("0");

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
    // Pool's currently-active liquidity. 0n means the pool was initialised
    // (so hasPool is true and slot0 returns a price) but no LP has been
    // minted yet — the user adding liquidity now is the FIRST LP, which
    // is the same operational regime as a fresh pool for slippage / UX
    // purposes. Happens when a prior createAndInitializePoolIfNecessary
    // succeeded but the follow-up mint reverted: the init persists,
    // leaving the pool partially set up.
    const poolLiquidityQ = useReadContract({
        address: pool,
        abi: V3_POOL_ABI,
        functionName: "liquidity",
        query: { enabled: hasPool },
    });
    const poolLiquidity = (poolLiquidityQ.data as bigint | undefined) ?? 0n;

    // Verify the picked fee tier is enabled on the factory. The Arc V3
    // factory (DeploySecurityV3.s.sol) only enables 1% / 2% / 3% — picking
    // 0.30% reverts at createPool with a generic message. Detect early and
    // surface a clear banner.
    const factoryTickSpacingQ = useReadContract({
        address: ADDRESSES.v3Factory,
        abi: [
            {
                type: "function",
                name: "feeAmountTickSpacing",
                stateMutability: "view",
                inputs: [{ name: "fee", type: "uint24" }],
                outputs: [{ name: "", type: "int24" }],
            },
        ] as const,
        functionName: "feeAmountTickSpacing",
        args: [feePip],
        query: { enabled: ADDRESSES.v3Factory !== zeroAddress },
    });
    const feeTierEnabled =
        (factoryTickSpacingQ.data as number | undefined ?? 0) > 0;
    /** True when there's no live LP on this pool — either the pool doesn't
     *  exist yet, or it exists but has zero liquidity. Same slippage rules
     *  apply in both cases. */
    const isFirstLP = !hasPool || poolLiquidity === 0n;
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

    const [amount0, setAmount0] = useState("");
    const [amount1, setAmount1] = useState("");

    // Fresh-pool implicit tick: when there's no pool yet, the user is
    // SEEDING the price via their typed amounts. The displayed MIN/MAX
    // (and the position the contract mints) should be centered on
    // THAT price, not on currentTick=0 which is just the default for an
    // uninitialised pool. Recompute from amount ratio whenever either
    // side changes; falls back to currentTick (0) before both are typed.
    const freshImplicitTick = useMemo<number | null>(() => {
        if (hasPool) return null;
        try {
            if (!amount0 || !amount1) return null;
            const a0Raw = parseUnits(amount0, t0.decimals);
            const a1Raw = parseUnits(amount1, t1.decimals);
            if (a0Raw <= 0n || a1Raw <= 0n) return null;
            // Use Number division (sufficient precision since these are
            // raw uints under 2^53 for typical deposits).
            const rawPrice = Number(a1Raw) / Number(a0Raw);
            if (!isFinite(rawPrice) || rawPrice <= 0) return null;
            const t = Math.floor(Math.log(rawPrice) / Math.log(1.0001));
            return isFinite(t) ? t : null;
        } catch {
            return null;
        }
    }, [hasPool, amount0, amount1, t0.decimals, t1.decimals]);

    // Recompute ticks whenever the preset, current tick, or spacing changes.
    useEffect(() => {
        if (preset === "custom") return; // Custom = user controls min/max via the inputs below.
        // Fresh pool with amounts typed -> center on the implicit price.
        // Fresh pool without amounts -> stay on the default (currentTick=0)
        // until the user provides a ratio to derive from. Existing pool ->
        // use the live currentTick from slot0.
        const center = freshImplicitTick !== null ? freshImplicitTick : currentTick;
        const { tickLower: tl, tickUpper: tu } = presetTickRange(
            preset,
            center,
            tickSpacing || 60,
        );
        setTickLower(tl);
        setTickUpper(tu);
    }, [preset, currentTick, tickSpacing, freshImplicitTick]);

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
    // Which side did the user last type into. The auto-quote effect uses
    // this to pick which derivation runs (token0 → token1 or the other
    // way around) without the two effects clobbering each other.
    const [lastEdited, setLastEdited] = useState<"0" | "1">("0");

    // V3 auto-quote: on an existing pool, the chosen range + current sqrt
    // price fix the ratio between token0 and token1 deposits. Typing one
    // side should reveal what the other will be — same UX shape as V2
    // reserves dictating the counter-amount, just driven by tick math. On
    // a fresh pool we skip this because the user is SETTING the seed price
    // via the typed amounts themselves; auto-quoting would erase intent.
    const sqrtPriceX96 = slot0Q.data
        ? ((slot0Q.data as readonly [bigint, number, ...unknown[]])[0])
        : 0n;

    useEffect(() => {
        if (!hasPool || sqrtPriceX96 === 0n) return;
        if (lastEdited !== "0" || !amount0) return;
        try {
            const a0Raw = parseUnits(amount0, t0.decimals);
            if (a0Raw <= 0n) return;
            const sqrtLower = getSqrtRatioAtTick(tickLower);
            const sqrtUpper = getSqrtRatioAtTick(tickUpper);
            const a1Raw = quoteOtherAmount(
                sqrtPriceX96,
                sqrtLower,
                sqrtUpper,
                /* typedIsToken0 */ true,
                a0Raw,
            );
            setAmount1(a1Raw > 0n ? formatUnits(a1Raw, t1.decimals) : "");
        } catch {
            /* parse / range errors ignored mid-typing */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [amount0, tickLower, tickUpper, sqrtPriceX96, hasPool, lastEdited, t0.decimals, t1.decimals]);

    useEffect(() => {
        if (!hasPool || sqrtPriceX96 === 0n) return;
        if (lastEdited !== "1" || !amount1) return;
        try {
            const a1Raw = parseUnits(amount1, t1.decimals);
            if (a1Raw <= 0n) return;
            const sqrtLower = getSqrtRatioAtTick(tickLower);
            const sqrtUpper = getSqrtRatioAtTick(tickUpper);
            const a0Raw = quoteOtherAmount(
                sqrtPriceX96,
                sqrtLower,
                sqrtUpper,
                /* typedIsToken0 */ false,
                a1Raw,
            );
            setAmount0(a0Raw > 0n ? formatUnits(a0Raw, t0.decimals) : "");
        } catch {
            /* parse / range errors ignored mid-typing */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [amount1, tickLower, tickUpper, sqrtPriceX96, hasPool, lastEdited, t0.decimals, t1.decimals]);

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
    // Single Asset Zap approval routes to the Zap contract (separate
    // allowance scope from the NPM-side dual flow).
    const { ensureAllowance: approveZap0 } = useApproveIfNeeded(
        t0.address,
        ADDRESSES.v3Zap,
    );
    const { ensureAllowance: approveZap1 } = useApproveIfNeeded(
        t1.address,
        ADDRESSES.v3Zap,
    );

    const [submitting, setSubmitting] = useState(false);

    // V3 zap quote for the pre-sign breakdown panel. Pulls the contract's
    // own closed-form math via the new quoteZap view helper (audit
    // improvement #4) so the user reads the same swap leg + expected
    // liquidity the contract will execute. Only fires in Single Asset mode
    // with a pool + amount in flight.
    const singleTypedRaw = (() => {
        try {
            if (mode !== "single") return 0n;
            if (zapTokenSide === "0" && amount0)
                return parseUnits(amount0, t0.decimals);
            if (zapTokenSide === "1" && amount1)
                return parseUnits(amount1, t1.decimals);
        } catch {
            /* ignore parse errors during typing */
        }
        return 0n;
    })();
    const v3QuoteQ = useReadContract({
        address: ADDRESSES.v3Zap,
        abi: V3_ZAP_ABI,
        functionName: "quoteZap",
        args: [
            {
                tokenIn: zapTokenSide === "0" ? t0.address : t1.address,
                otherToken: zapTokenSide === "0" ? t1.address : t0.address,
                fee: feePip,
                amountIn: singleTypedRaw,
                tickLower: tickLower,
                tickUpper: tickUpper,
            },
        ],
        query: {
            enabled:
                mode === "single" &&
                zapEnabled &&
                hasPool &&
                singleTypedRaw > 0n,
        },
    });
    const v3Quote = v3QuoteQ.data as
        | {
              swapAmount: bigint;
              expectedOut: bigint;
              expectedAmount0: bigint;
              expectedAmount1: bigint;
              expectedLiquidity: bigint;
          }
        | undefined;

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
    // String inputs like "0", "0.00" are truthy but parse to 0n on-chain.
    // Use the raw parse to gate validation so the user can't sneak past with
    // a placeholder zero.
    const a0Positive = (() => {
        try {
            return amount0 ? parseUnits(amount0, t0.decimals) > 0n : false;
        } catch {
            return false;
        }
    })();
    const a1Positive = (() => {
        try {
            return amount1 ? parseUnits(amount1, t1.decimals) > 0n : false;
        } catch {
            return false;
        }
    })();
    const sufficientAmounts = hasPool
        ? (!aboveRange && a0Positive) || (!belowRange && a1Positive)
        : a0Positive && a1Positive;

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

    // Audit low [28]: gate submit on poolAddrQ loading. The page used to
    // submit with a stale hasPool=false closure if the user hit Submit
    // before the factory.getPool query resolved, taking the fresh-pool
    // branch on a pool that already existed.
    // Single mode has its own gate: zap deployed + pool exists + the active
    // side typed AND backed by enough balance. Range validity matters less
    // because the zap is hardcoded to Max Range, but we still require the
    // preset to be "max" defensively (a stale state could otherwise sign
    // a different range).
    const singleSideTyped = zapTokenSide === "0" ? a0Positive : a1Positive;
    const singleSideHasBalance =
        zapTokenSide === "0" ? enoughBalance0 : enoughBalance1;
    const canSubmit =
        mode === "dual"
            ? !!account &&
              npmEnabled &&
              feeTierEnabled &&
              !submitting &&
              !poolAddrQ.isLoading &&
              validRange &&
              sufficientAmounts &&
              enoughBalance
            : !!account &&
              zapEnabled &&
              feeTierEnabled &&
              hasPool &&
              !submitting &&
              preset === "max" &&
              singleSideTyped &&
              singleSideHasBalance;

    async function onSubmit() {
        if (!account || !publicClient) return;
        try {
            setSubmitting(true);

            // Single Asset Zap branch. Pulls the typed side, calls
            // v3Zap.zapInMaxRange which swaps half via the pool and mints
            // a max-range NFT to the user.
            if (mode === "single") {
                if (ADDRESSES.v3Zap === zeroAddress) {
                    throw new Error("V3 Zap not wired in this env.");
                }
                const typedRaw = zapTokenSide === "0"
                    ? a0Positive ? parseUnits(amount0, t0.decimals) : 0n
                    : a1Positive ? parseUnits(amount1, t1.decimals) : 0n;
                if (typedRaw <= 0n) throw new Error("Enter an amount.");
                const tokenIn = zapTokenSide === "0" ? t0.address : t1.address;
                const otherToken = zapTokenSide === "0" ? t1.address : t0.address;

                // Approve the zap for the typed side only. Zap pulls tokenIn
                // up-front then swaps via pool callback.
                if (zapTokenSide === "0") await approveZap0(typedRaw);
                else await approveZap1(typedRaw);

                const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMin * 60);

                // Audit follow-up: the V3 zap now accepts caller-signed
                // slippage on both the internal swap leg AND the final mint.
                // Use quoteZap's expectedOut as the basis - that matches the
                // contract's view of expected output, so any discrepancy is
                // genuine price-impact, not a spec mismatch.
                //
                // Price-impact safety buffer: V3 pools are constant-product
                // within their range, so a swap of `half` moves the price.
                // In thin pools the move can be 20-30%. quoteZap returns the
                // SPOT-price estimate (no impact), and the actual on-chain
                // swap delivers less. We apply a 30% safety buffer below
                // quoteZap's value as the swap floor — generous in deep
                // pools (and the dust is swept back), correct in thin pools.
                // Proper SqrtPriceMath-based quote is a future v3 zap upgrade.
                if (!v3Quote || v3Quote.expectedOut === 0n) {
                    throw new Error(
                        "V3 zap quote unavailable (slot0 still loading or pool too thin). Refresh and retry.",
                    );
                }
                const amountOtherMinSwap = (v3Quote.expectedOut * 70n) / 100n;

                const zapArgs = [
                    {
                        tokenIn,
                        otherToken,
                        fee: feePip,
                        amountIn: typedRaw,
                        amountOtherMinSwap,
                        amount0Min: 0n,
                        amount1Min: 0n,
                        deadline,
                        recipient: account,
                    },
                ] as const;

                const hash = await writeContractAsync({
                    address: ADDRESSES.v3Zap,
                    abi: V3_ZAP_ABI,
                    functionName: "zapInMaxRange",
                    args: zapArgs,
                });
                const receipt = await publicClient.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") {
                    throw new Error(
                        `V3 Zap reverted on-chain (tx ${hash.slice(0, 10)}…). Common causes: pool moved between read and exec, USDC blocklist precompile, insufficient input.`,
                    );
                }
                pushToast({
                    kind: "liquidity",
                    token0: { address: t0.address, symbol: t0.symbol },
                    token1: { address: t1.address, symbol: t1.symbol },
                    amount0Formatted: zapTokenSide === "0" ? amount0 : "—",
                    amount1Formatted: zapTokenSide === "1" ? amount1 : "—",
                    lpFormatted: "1 NFT (Max Range)",
                    poolHref: pool ? `/pool/${pool}` : "/positions",
                    explorerUrl: `${arcTestnet.blockExplorers?.default.url}/tx/${hash}`,
                });
                router.push("/positions?tab=concentrated");
                return;
            }

            const a0Raw = amount0 ? parseUnits(amount0, t0.decimals) : 0n;
            const a1Raw = amount1 ? parseUnits(amount1, t1.decimals) : 0n;
            // First-LP path: covers both (a) the pool doesn't exist yet and
            // we're seeding it AND (b) the pool exists from a previous
            // failed mint but liquidity is still 0. In both cases we're
            // setting the effective seed of the pool's first position, so
            // there's no front-runnable price to slip against — the
            // slot0 verification below detects pre-init grief, and the
            // tick-quantisation rounding is the only realistic source of
            // amount drift. Force a 5% floor so 0.5% defaults don't false-
            // revert. Existing pools with liquidity keep the user's chosen
            // slippage where it actually matters.
            const effectiveSlippageBps = isFirstLP ? Math.max(slippageBps, 500) : slippageBps;
            const slipDen = 10_000n - BigInt(effectiveSlippageBps);

            let actualTickLower = tickLower;
            let actualTickUpper = tickUpper;

            // Fresh-pool branch. Two on-chain calls (init + mint) bracketed
            // by a slot0 verification — see the security commentary below.
            if (!hasPool) {
                if (a0Raw === 0n || a1Raw === 0n) {
                    throw new Error(
                        "Fresh V3 pools need both Token 1 and Token 2 amounts.",
                    );
                }
                const rawPrice = Number(a1Raw) / Number(a0Raw);
                const sqrtX96 = encodeSqrtPriceX96(rawPrice);
                // Audit medium [9]: refuse to broadcast if the encoded seed
                // sits outside the V3 legal range — initialise() would
                // revert with R but we'd already have paid the gas.
                if (!isSqrtPriceInRange(sqrtX96)) {
                    throw new Error(
                        "Seed price falls outside the V3 legal range. Pick deposit amounts whose ratio is closer to 1.",
                    );
                }
                const implicitTick = Math.floor(Math.log(rawPrice) / Math.log(1.0001));
                if (!isFinite(implicitTick)) {
                    throw new Error("Could not derive a seed tick from the amounts.");
                }
                const halfWidth = Math.max(
                    tickSpacing,
                    Math.floor((tickUpper - tickLower) / 2),
                );
                actualTickLower = nearestUsableTick(
                    implicitTick - halfWidth,
                    tickSpacing,
                );
                actualTickUpper = nearestUsableTick(
                    implicitTick + halfWidth,
                    tickSpacing,
                );

                // Init the pool and wait for the receipt before approving
                // / minting. If init reverted we must abort or the next
                // tx would mint against an uninitialised pool.
                const initHash = await writeContractAsync({
                    address: ADDRESSES.v3PositionManager,
                    abi: V3_NPM_ABI,
                    functionName: "createAndInitializePoolIfNecessary",
                    args: [t0.address, t1.address, feePip, sqrtX96],
                });
                const initReceipt = await publicClient.waitForTransactionReceipt({ hash: initHash });
                if (initReceipt.status !== "success") {
                    throw new Error(
                        `Pool init reverted (tx ${initHash.slice(0, 10)}…). Retry with a different ratio or fee tier.`,
                    );
                }

                // AUDIT CRITICAL [2]/[22]: PoolInitializer's createAndInit-
                // ializePoolIfNecessary is a SILENT no-op when the pool was
                // already initialised by someone else. A front-runner could
                // have pre-initialised at a malicious price between our
                // submit and our receipt landing; without this check we'd
                // mint into the attacker's price. Verify the live slot0
                // matches what we asked for (1% tolerance for rounding).
                await poolAddrQ.refetch();
                const livePool = (await publicClient.readContract({
                    address: ADDRESSES.v3Factory,
                    abi: V3_FACTORY_ABI,
                    functionName: "getPool",
                    args: [t0.address, t1.address, feePip],
                })) as Address;
                if (!livePool || livePool === zeroAddress) {
                    throw new Error("V3 factory did not return a pool address after init.");
                }
                const liveSlot0 = (await publicClient.readContract({
                    address: livePool,
                    abi: V3_POOL_ABI,
                    functionName: "slot0",
                })) as readonly [bigint, number, ...unknown[]];
                const liveSqrtX96 = liveSlot0[0] as bigint;
                const dev =
                    liveSqrtX96 > sqrtX96
                        ? ((liveSqrtX96 - sqrtX96) * 10_000n) / sqrtX96
                        : ((sqrtX96 - liveSqrtX96) * 10_000n) / sqrtX96;
                if (dev > 100n) {
                    throw new Error(
                        "Pool init landed at a price ~1%+ off the seed (likely a front-run). Refresh and retry — UI will re-read the live tick.",
                    );
                }

                // Re-anchor the range around the live tick so the slip-min
                // computation below targets the correct deposit ratios.
                const liveTick = Number(liveSlot0[1]);
                actualTickLower = nearestUsableTick(liveTick - halfWidth, tickSpacing);
                actualTickUpper = nearestUsableTick(liveTick + halfWidth, tickSpacing);
            }

            await Promise.all([
                a0Raw > 0n ? approve0(a0Raw) : Promise.resolve(),
                a1Raw > 0n ? approve1(a1Raw) : Promise.resolve(),
            ]);

            const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMin * 60);

            // Resolve the pool address - either the React-state `pool` (set
            // when poolAddrQ hydrated) or the fresh-pool branch's livePool
            // (read directly above after the init tx confirmed). The previous
            // `pool ?? ADDRESSES.v3Factory` fallback silently routed slot0()
            // to the factory (no slot0) which threw and dropped the
            // LiquidityAmounts pre-compute entirely.
            const resolvedPool = (pool && pool !== zeroAddress
                ? pool
                : (await publicClient.readContract({
                      address: ADDRESSES.v3Factory,
                      abi: V3_FACTORY_ABI,
                      functionName: "getPool",
                      args: [t0.address, t1.address, feePip],
                  })) as Address);
            if (!resolvedPool || resolvedPool === zeroAddress) {
                throw new Error("V3 pool address unresolved — refresh and retry.");
            }

            // Pre-compute the EXACT amounts the v3-pool will consume so the
            // slippage minimum can be tight without tripping M0/M1. V3 binds
            // on the smaller-liquidity leg, so the user's other leg is
            // typically partially consumed; without this step amount{0,1}Min
            // derived from the user's typed amount{0,1}Desired routinely
            // reverted because the binding logic skewed actual deposits.
            //
            // Uses the TickMath-exact getSqrtRatioAtTick (bit-for-bit port
            // of v3-core/TickMath) so our liquidity math matches the
            // on-chain mint flow to the last bit.
            let exactA0 = a0Raw;
            let exactA1 = a1Raw;
            try {
                const liveSqrt = ((await publicClient.readContract({
                    address: resolvedPool,
                    abi: V3_POOL_ABI,
                    functionName: "slot0",
                })) as readonly [bigint, number, ...unknown[]])[0] as bigint;
                const sqrtA = getSqrtRatioAtTick(actualTickLower);
                const sqrtB = getSqrtRatioAtTick(actualTickUpper);
                const liquidity = getLiquidityForAmounts(
                    liveSqrt,
                    sqrtA,
                    sqrtB,
                    a0Raw,
                    a1Raw,
                );
                if (liquidity > 0n) {
                    const consumed = getAmountsForLiquidity(
                        liveSqrt,
                        sqrtA,
                        sqrtB,
                        liquidity,
                    );
                    // Pad the desired amounts by 1 unit so the on-chain
                    // round-to-nearest-pool-tick precision can't make
                    // amount0Desired < what V3 actually wants for this
                    // liquidity (V3 caps at desired, so under-prediction
                    // is harmless; over-prediction by 1 unit costs the
                    // user 1e-18 of either token — negligible).
                    exactA0 = consumed.amount0 > 0n ? consumed.amount0 + 1n : 0n;
                    exactA1 = consumed.amount1 > 0n ? consumed.amount1 + 1n : 0n;
                }
            } catch {
                /* fall back to user's raw amounts */
            }

            // AUDIT CRITICAL [2]/[22]: slippage applies on the EXACT
            // consumed amounts so a tight slip can't false-revert.
            // First-LP exception: when no other LP exists in the pool, the
            // price can't drift between simulate and execute (we're setting
            // it ourselves), and the tick-quantisation rounding can wipe a
            // few wei off each leg in ways that even 5% slippage doesn't
            // always absorb (binding leg can collapse to ~0 against a
            // microscopic liquidity). Set minimums to 0 in this regime so
            // the slot0-verify above is the only on-chain guard; legitimate
            // first-LP can't be false-reverted.
            const amount0Min = isFirstLP ? 0n : (exactA0 * slipDen) / 10_000n;
            const amount1Min = isFirstLP ? 0n : (exactA1 * slipDen) / 10_000n;

            const mintArgs = [
                {
                    token0: t0.address,
                    token1: t1.address,
                    fee: feePip,
                    tickLower: actualTickLower,
                    tickUpper: actualTickUpper,
                    amount0Desired: exactA0,
                    amount1Desired: exactA1,
                    amount0Min,
                    amount1Min,
                    recipient: account,
                    deadline,
                },
            ] as const;

            // Simulate the mint before broadcasting. NOT fatal: if simulate
            // reverts we still try the real tx, because Arc's USDC blocklist
            // precompile and other chain-specific quirks can produce false
            // positives in eth_call that don't reproduce on-chain. The
            // simulate output goes to the browser console so DevTools shows
            // the full revert chain — short / cause / data — for diagnosis,
            // and a warning toast tells the user we proceeded despite a sim
            // warning so a real on-chain revert isn't a surprise.
            try {
                await publicClient.simulateContract({
                    address: ADDRESSES.v3PositionManager,
                    abi: V3_NPM_ABI,
                    functionName: "mint",
                    args: mintArgs,
                    account,
                });
            } catch (simErr: unknown) {
                // Walk every level of the viem error chain so a bare
                // "execution reverted" still surfaces the underlying revert
                // data (4byte selector, ABI-decoded args, etc).
                const chain: string[] = [];
                let cur: unknown = simErr;
                for (let i = 0; cur && i < 6; i++) {
                    const o = cur as Record<string, unknown>;
                    const bits = [
                        o.errorName,
                        o.reason,
                        o.shortMessage,
                        o.signature,
                        o.data,
                    ]
                        .filter((v) => v !== undefined && v !== null && v !== "")
                        .map((v) => String(v));
                    if (bits.length > 0) chain.push(bits.join(" | "));
                    cur = (o.cause as unknown) ?? null;
                }
                // eslint-disable-next-line no-console
                console.warn("[V3 mint] simulate reverted, proceeding anyway:", {
                    err: simErr,
                    chain,
                    mintArgs,
                    resolvedPool,
                });
                pushToast({
                    kind: "error",
                    title: "V3 mint sim warning",
                    message: `Simulate flagged a revert (${chain[0] ?? "unknown"}); broadcasting the real tx anyway. Open DevTools console for the full chain.`,
                });
            }

            // Use the EXACT consumed amounts as Desired so V3's mint binds
            // both legs exactly. If we passed the raw user amounts, V3
            // would consume less than amount{0,1}Min on the non-binding
            // leg and revert.
            const hash = await writeContractAsync({
                address: ADDRESSES.v3PositionManager,
                abi: V3_NPM_ABI,
                functionName: "mint",
                args: mintArgs,
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
            {/* Dual / Single tabs. Single Asset shows only when zap is wired
                AND a pool exists (zap needs price + tokens to swap). */}
            <div className="flex items-center gap-4 text-sm">
                <ModeTab
                    active={mode === "dual"}
                    onClick={() => setMode("dual")}
                >
                    Dual Token
                </ModeTab>
                <ModeTab
                    active={mode === "single"}
                    onClick={() => zapEnabled && hasPool && setMode("single")}
                    disabled={!zapEnabled || !hasPool}
                    disabledReason={
                        !zapEnabled
                            ? "Zap not deployed in this env"
                            : "Single Asset Zap needs an existing pool to swap through"
                    }
                >
                    Single Asset
                </ModeTab>
            </div>

            {/* Single Asset mode forces Max Range. Switching to Single auto-
                sets preset to "max" so the user can't sign a narrow-range
                zap (the half/half split assumes full range). The preset row
                renders below the tab; we hide the non-max chips in single
                mode to keep the surface tidy. */}
            {mode === "single" && preset !== "max" && (
                <button type="button"
                    onClick={() => setPreset("max")}
                    className="w-full rounded-xl border border-arc-warn/30 bg-arc-warn/10 px-3 py-2 text-xs text-arc-warn transition-colors hover:bg-arc-warn/15"
                >
                    Single Asset Zap requires Max Range. Click to switch.
                </button>
            )}

            {/* Range presets. In single mode we only render the Max chip
                because the zap's half/half split is well-conditioned only
                for full-range positions (narrow ranges need a closed-form
                split that depends on the chosen ticks). */}
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
                    )
                        .filter((p) => mode !== "single" || p.key === "max")
                        .map((p) => (
                            <button type="button"
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
                        // nearestUsableTick rounds AND clamps back inside
                        // the aligned [MIN, MAX] domain so the on-chain
                        // checkTicks require never trips.
                        setTickLower(nearestUsableTick(t, tickSpacing || 60));
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
                        setTickUpper(nearestUsableTick(t, tickSpacing || 60));
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
            {!feeTierEnabled && !factoryTickSpacingQ.isLoading && (
                <div className="rounded-xl border border-arc-danger/40 bg-arc-danger/10 p-3 text-xs text-arc-danger">
                    Fee tier {(feePip / 10_000).toFixed(2)}% is not enabled on
                    this V3 factory. Pick one of the active tiers: 0.05%, 0.30%,
                    1%, 2%, or 3%. (URL overrides: <code>?fee=5</code>,{" "}
                    <code>?fee=30</code>, <code>?fee=100</code>,{" "}
                    <code>?fee=200</code>, <code>?fee=300</code>.)
                </div>
            )}
            {feeTierEnabled && !hasPool && (
                <div className="rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-3 text-xs text-arc-warn">
                    Pool doesn&apos;t exist yet. Submitting will create it via
                    createAndInitializePoolIfNecessary with the midpoint of
                    your range as the seed price.
                </div>
            )}
            {feeTierEnabled && hasPool && isFirstLP && (
                <div className="rounded-xl border border-arc-cta-hover/30 bg-arc-cta-hover/10 p-3 text-xs text-arc-text-muted">
                    Pool exists but has 0 liquidity — you&apos;ll be the first
                    LP. The Current price shown above is the seed price set
                    when the pool was initialised; your deposit must match
                    that ratio (or be partially consumed by the binding leg).
                </div>
            )}

            {/* Token inputs. Single-mode renders one editable input + one
                clearly-locked stub so the user instantly reads which side
                they're zapping FROM. The arrow icon between flips the
                input side. */}
            {mode === "dual" ? (
                <>
                    <V3TokenInput
                        label={`Token 1 (${t0.symbol})`}
                        token={t0}
                        value={amount0}
                        onChange={(v) => {
                            setLastEdited("0");
                            setAmount0(v);
                        }}
                        balance={bal0.data as bigint | undefined}
                        disabled={aboveRange}
                        disabledReason="Above range - only Token 2 is needed"
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
                        onChange={(v) => {
                            setLastEdited("1");
                            setAmount1(v);
                        }}
                        balance={bal1.data as bigint | undefined}
                        disabled={belowRange}
                        disabledReason="Below range - only Token 1 is needed"
                    />
                </>
            ) : (
                <>
                    {/* Active side (the one the user pays in). */}
                    {zapTokenSide === "0" ? (
                        <V3TokenInput
                            label={`Token 1 (${t0.symbol})`}
                            token={t0}
                            value={amount0}
                            onChange={(v) => {
                                setLastEdited("0");
                                setAmount0(v);
                            }}
                            balance={bal0.data as bigint | undefined}
                        />
                    ) : (
                        <V3TokenInput
                            label={`Token 1 (${t1.symbol})`}
                            token={t1}
                            value={amount1}
                            onChange={(v) => {
                                setLastEdited("1");
                                setAmount1(v);
                            }}
                            balance={bal1.data as bigint | undefined}
                        />
                    )}
                    <div className="flex justify-center">
                        <button type="button"
                            onClick={() => {
                                // Flip which leg the user is paying with.
                                // Clear the other-side amount to avoid
                                // confusing partial state across the flip.
                                setZapTokenSide((s) => (s === "0" ? "1" : "0"));
                                setAmount0("");
                                setAmount1("");
                            }}
                            title="Flip zap direction"
                            className="-my-2 rounded-xl border border-arc-border bg-arc-bg-elevated p-2 transition-colors hover:bg-white/5"
                        >
                            <ArrowUpDown className="h-4 w-4 text-arc-text" />
                        </button>
                    </div>
                    {/* Locked counter-side stub. Heavier border + dimmed
                        backdrop + centered Lock badge to mirror Hyperswap's
                        clarity ("this side comes from the swap, you don't
                        type it"). */}
                    <V3LockedLeg
                        label={`Token 2 (${zapTokenSide === "0" ? t1.symbol : t0.symbol})`}
                        token={zapTokenSide === "0" ? t1 : t0}
                    />
                </>
            )}

            {/* Pre-sign breakdown - Single Asset only. Calls quoteZap on the
                V3 zap contract so the user reads the SAME split + expected
                liquidity the on-chain mint will use. Audit improvement #5. */}
            {mode === "single" && v3Quote && singleTypedRaw > 0n && (
                <ZapBreakdownPanel
                    variant="v3"
                    tokenIn={
                        zapTokenSide === "0"
                            ? { symbol: t0.symbol, decimals: t0.decimals }
                            : { symbol: t1.symbol, decimals: t1.decimals }
                    }
                    tokenOther={
                        zapTokenSide === "0"
                            ? { symbol: t1.symbol, decimals: t1.decimals }
                            : { symbol: t0.symbol, decimals: t0.decimals }
                    }
                    amountIn={singleTypedRaw}
                    swapAmount={v3Quote.swapAmount}
                    expectedOut={v3Quote.expectedOut}
                    expectedAmount0={v3Quote.expectedAmount0}
                    expectedAmount1={v3Quote.expectedAmount1}
                    expectedLiquidity={v3Quote.expectedLiquidity}
                    /* zapTokenSide reflects which leg of the SORTED (t0,t1)
                       order the user is paying with. Passing it lets the
                       panel map expectedAmount0/1 back to tokenIn/tokenOther
                       without inferring from symbols (which fails for
                       USDC/ETH since "eth" < "usdc" but USDC < ETH by
                       address). */
                    tokenInIsT0={zapTokenSide === "0"}
                    slippageBps={slippageBps}
                />
            )}

            <button type="button"
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
                      ? mode === "single"
                          ? "Zapping into pool…"
                          : hasPool
                            ? "Minting position…"
                            : "Initialising pool + minting…"
                      : mode === "single"
                        ? !singleSideTyped
                            ? "Enter an amount"
                            : !singleSideHasBalance
                              ? `Insufficient ${zapTokenSide === "0" ? t0.symbol : t1.symbol} balance`
                              : "Zap into pool"
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
    // Precision ladder: keep 6 decimals for human-scale prices and step up
    // to scientific for sub-1e-4 values so a USDC/ETH range never displays
    // as "0.000000" (which makes the user think the preset failed).
    const fmt = (v: number) => {
        if (v === 0 || !isFinite(v)) return "0";
        if (v >= 0.0001) return v.toFixed(6);
        if (v >= 0.000_000_1) return v.toFixed(10);
        return v.toExponential(2);
    };
    const [text, setText] = useState(fmt(value));
    useEffect(() => setText(fmt(value)), [value]);
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
                        <button type="button"
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

function ModeTab({
    active,
    onClick,
    disabled,
    disabledReason,
    children,
}: {
    active: boolean;
    onClick: () => void;
    disabled?: boolean;
    disabledReason?: string;
    children: React.ReactNode;
}) {
    return (
        <button type="button"
            onClick={onClick}
            disabled={disabled}
            title={disabled ? disabledReason : undefined}
            className={cn(
                "relative pb-1 text-sm font-semibold transition-colors",
                disabled
                    ? "cursor-not-allowed text-arc-text-faint"
                    : active
                      ? "text-arc-text after:absolute after:-bottom-1 after:left-0 after:right-0 after:h-[2px] after:rounded-full after:bg-arc-cta-hover"
                      : "text-arc-text-muted hover:text-arc-text",
            )}
        >
            {children}
        </button>
    );
}

/**
 * Locked counter-side stub for the Single Asset Zap. The whole field gets
 * a dimmed backdrop + centered Lock badge with a clear "auto-zapped via
 * the pool" caption so the user instantly reads "this side comes from
 * the swap, you don't type it". Replaces the prior thin grey '$-' line
 * which felt like a bug.
 */
function V3LockedLeg({ label, token }: { label: string; token: V3Token }) {
    return (
        <div className="relative overflow-hidden rounded-2xl border border-arc-border bg-white/[0.015] p-4">
            <div className="mb-2 flex items-center justify-between">
                <span className="text-sm text-arc-text-muted">{label}</span>
                <div className="flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-semibold opacity-70">
                    <TokenIcon symbol={token.symbol} size={20} />
                    {token.symbol}
                </div>
            </div>
            <div className="text-3xl font-semibold tabular-nums text-arc-text-faint">
                0
            </div>
            <div className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-arc-text-muted">
                <Lock className="h-3 w-3" />
                Auto-zapped via the pool
            </div>
            {/* Dim overlay reinforces the lock visually without obscuring
                the value entirely - matches the Hyperswap pattern. */}
            <div className="pointer-events-none absolute inset-0 bg-black/35 backdrop-blur-[1px]" />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="flex items-center gap-2 rounded-full border border-arc-border bg-black/70 px-3 py-1.5 text-[11px] font-semibold text-arc-text-muted shadow-arc-card backdrop-blur-md">
                    <Lock className="h-3 w-3" />
                    This field is locked in Single Asset Zap
                </div>
            </div>
        </div>
    );
}
