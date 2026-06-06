/**
 * Lightweight Uniswap V3 tick math. Pure-TS port of the bits we need on the
 * frontend (price <-> tick conversions, range-preset tick computation,
 * liquidity preview). Match the Solidity behaviour bit-for-bit at the input
 * scales we use (decimals up to 30), within JS number/bigint precision.
 *
 * For exact production-grade math you would use sqrt-x96 fixed-point in
 * BigInt land; we use float exp/log for human-facing price strings because
 * the tick rounding to spacing makes anything finer than 1bp moot.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/**
 * Canonical fee -> tickSpacing map. Pulled from Uniswap V3's factory
 * constructor (0.05/0.30/1%) plus Arc's two extra tiers (2%, 3%) which the
 * ArcadeV3 deploy script enabled at spacing 200. Use this as a fallback
 * when reading slot0.tickSpacing for a pool that hasn't been deployed yet,
 * so the UI rounds ticks to the value the pool will actually require on
 * mint. Mismatched spacing is the silent-revert classic for fresh-pool
 * mints because the v3-pool's mint() asserts (tick % tickSpacing == 0).
 */
const FEE_TICK_SPACING: Record<number, number> = {
    100: 1, // 0.01%
    500: 10, // 0.05%
    3000: 60, // 0.30%
    10000: 200, // 1%
    20000: 200, // 2% (Arc extension)
    30000: 200, // 3% (Arc extension)
};

export function defaultTickSpacingForFee(feePip: number): number {
    return FEE_TICK_SPACING[feePip] ?? 60;
}

/**
 * Price-to-tick: tick = log(price) / log(1.0001).
 * `price` is token1-per-token0 in raw on-chain ratio (no decimals scaling
 * yet — the caller is responsible for converting decimal-aware to raw).
 */
function priceToTick(price: number): number {
    if (!isFinite(price) || price <= 0) return 0;
    return Math.floor(Math.log(price) / Math.log(1.0001));
}

function tickToPrice(tick: number): number {
    return Math.pow(1.0001, tick);
}

/**
 * Decimal-aware: turn a human-typed price (token1 per token0, in their
 * display decimals) into the raw on-chain price (1.0001^tick).
 *
 *   tick = log(price * 10^(decimals1 - decimals0)) / log(1.0001)
 */
export function priceToTickWithDecimals(
    price: number,
    decimals0: number,
    decimals1: number,
): number {
    if (!isFinite(price) || price <= 0) return 0;
    const adjusted = price * Math.pow(10, decimals1 - decimals0);
    return Math.floor(Math.log(adjusted) / Math.log(1.0001));
}

export function tickToPriceWithDecimals(
    tick: number,
    decimals0: number,
    decimals1: number,
): number {
    return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/**
 * Round a tick down to the nearest multiple of `spacing`. Used to make sure
 * the lower/upper tick we feed into mint() is a valid tick at the pool's
 * spacing (the V3 core reverts otherwise).
 */
function roundTickDown(tick: number, spacing: number): number {
    const r = tick - (tick % spacing);
    return tick < 0 && tick % spacing !== 0 ? r - spacing : r;
}

function roundTickUp(tick: number, spacing: number): number {
    // JS modulo: (-7) % 60 == -7, so the naive `(spacing - tick % spacing)`
    // path yields a value > spacing for negative non-aligned ticks and
    // overshoots by one whole spacing. Normalise the modulus to [0, spacing)
    // before deriving the gap.
    const mod = ((tick % spacing) + spacing) % spacing;
    if (mod === 0) return tick;
    return tick + (spacing - mod);
}

/**
 * Clamp a tick to the global Uniswap V3 [MIN_TICK, MAX_TICK] domain.
 */
function clampTick(tick: number): number {
    if (tick < MIN_TICK) return MIN_TICK;
    if (tick > MAX_TICK) return MAX_TICK;
    return tick;
}

/**
 * Snap a tick to the nearest spacing-aligned multiple inside the
 * [MIN_TICK, MAX_TICK] domain, never overshooting either bound. The naive
 * roundTickDown/roundTickUp chain produces values like 887280 when given
 * MAX_TICK=887272 with spacing=60 (because 60 - (887272 % 60) = 8), which
 * the on-chain v3-pool then rejects via the TUM check. This helper bounds
 * BACK after rounding so the UI never asks the chain to validate a tick
 * outside its legal domain.
 */
export function nearestUsableTick(tick: number, spacing: number): number {
    const clamped = clampTick(tick);
    const rounded = Math.round(clamped / spacing) * spacing;
    // Bound back inside the legal aligned window so the v3-pool's
    // require(tickLower >= MIN_TICK && tickUpper <= MAX_TICK) never fails.
    const minAligned = Math.ceil(MIN_TICK / spacing) * spacing;
    const maxAligned = Math.floor(MAX_TICK / spacing) * spacing;
    if (rounded < minAligned) return minAligned;
    if (rounded > maxAligned) return maxAligned;
    return rounded;
}

/**
 * Compute (tickLower, tickUpper) for one of the five HyperSwap-style range
 * presets, given the pool's current tick + tick spacing. The preset name is
 * the percentage of the current price the range spans either side.
 */
export type RangePreset =
    | "max"
    | "passive"
    | "wide"
    | "narrow"
    | "aggressive"
    | "custom";

const PRESET_PCT: Record<Exclude<RangePreset, "max" | "custom">, number> = {
    passive: 0.5, // ±50%
    wide: 0.25, // ±25%
    narrow: 0.05, // ±5%
    aggressive: 0.01, // ±1%
};

export function presetTickRange(
    preset: RangePreset,
    currentTick: number,
    tickSpacing: number,
): { tickLower: number; tickUpper: number } {
    if (preset === "max") {
        // nearestUsableTick rounds AND clamps back into the legal aligned
        // domain so we never hand the v3-pool a tick that violates the
        // checkTicks() require.
        return {
            tickLower: nearestUsableTick(MIN_TICK, tickSpacing),
            tickUpper: nearestUsableTick(MAX_TICK, tickSpacing),
        };
    }
    if (preset === "custom") {
        return { tickLower: currentTick, tickUpper: currentTick };
    }
    const pct = PRESET_PCT[preset];
    const lowPrice = (1 - pct);
    const highPrice = 1 + pct;
    const tickLow = currentTick + priceToTick(lowPrice);
    const tickHigh = currentTick + priceToTick(highPrice);
    return {
        tickLower: nearestUsableTick(tickLow, tickSpacing),
        tickUpper: nearestUsableTick(tickHigh, tickSpacing),
    };
}

// Uniswap V3 sqrt-price bounds (matches v3-core TickMath constants).
const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/**
 * sqrtPriceX96 of a price = sqrt(price) * 2^96, BigInt-precise.
 *
 *   sqrtPriceX96 = floor(sqrt(num * 2^192 / den))
 *
 * where price = num / den. Computing sqrt directly in float (the previous
 * approach) silently returned 0n for sub-1e-29 prices because Math.sqrt
 * underflowed below 2^-48, and overshoots MAX_SQRT_RATIO for extreme
 * upside ratios — both cases would revert the pool's initialize() with no
 * client-side warning. The integer path stays faithful across the full
 * V3 legal range, and we surface an explicit error when the result
 * lands outside [MIN_SQRT_RATIO, MAX_SQRT_RATIO] so the caller can refuse
 * the mint instead of paying gas for a guaranteed revert.
 */
export function encodeSqrtPriceX96(price: number): bigint {
    if (!isFinite(price) || price <= 0) return 0n;
    // Decompose price into integer num/den with enough precision (we use
    // 1e18 as the denominator to capture sub-femto prices without losing
    // bits on the upper end).
    const SCALE = 10n ** 18n;
    let num: bigint;
    let den: bigint;
    if (price >= 1) {
        num = BigInt(Math.floor(price * 1e6)) * SCALE;
        den = 10n ** 6n * SCALE;
    } else {
        // For tiny prices, multiply both by 1e18 so we keep precision.
        num = BigInt(Math.floor(price * 1e18));
        den = SCALE;
    }
    if (num === 0n || den === 0n) return 0n;
    // sqrt(num/den) * 2^96 == sqrt(num * 2^192 / den)
    const inner = (num << 192n) / den;
    return bigintSqrt(inner);
}

/**
 * Babylonian-style sqrt over BigInt. Matches the value returned by
 * Math.floor(Math.sqrt(n)) for inputs that fit in a double, and stays
 * correct for inputs that don't.
 */
function bigintSqrt(n: bigint): bigint {
    if (n < 0n) throw new Error("sqrt of negative");
    if (n < 2n) return n;
    // Initial guess: 2^((bitLength+1)/2)
    let bits = 0;
    let x = n;
    while (x > 0n) {
        bits++;
        x >>= 1n;
    }
    let guess = 1n << BigInt((bits + 1) >> 1);
    while (true) {
        const next = (guess + n / guess) >> 1n;
        if (next >= guess) return guess;
        guess = next;
    }
}

export function isSqrtPriceInRange(sqrtX96: bigint): boolean {
    return sqrtX96 >= MIN_SQRT_RATIO && sqrtX96 <= MAX_SQRT_RATIO;
}

// -------------------------------------------------------------------
// LiquidityAmounts — port of Uniswap V3's LiquidityAmounts library
// (v3-periphery/contracts/libraries/LiquidityAmounts.sol). Used to
// pre-compute the exact amounts V3 will consume on a mint, so the user's
// amount0Desired/amount1Desired match what mint() actually takes — letting
// us submit a tight slippage min without tripping the V3 "M0/M1" check
// when the user's typed ratio doesn't perfectly align with the pool's
// price + range.
// -------------------------------------------------------------------

const Q96 = 1n << 96n;

/** liquidity = amount0 * sqrtA * sqrtB / (sqrtB - sqrtA) */
function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
    const [a, b] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
    const intermediate = (a * b) / Q96;
    return (amount0 * intermediate) / (b - a);
}

/** liquidity = amount1 * 2^96 / (sqrtB - sqrtA) */
function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
    const [a, b] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
    return (amount1 * Q96) / (b - a);
}

/**
 * Given a typed amount on one side, the current sqrtPrice, and the active
 * range, return how much of the other side V3 will actually consume on
 * mint. This is the UI auto-quote: same idea as V2 reserves dictating the
 * other-side amount, except in V3 it's the chosen range relative to the
 * current price that fixes the ratio (and out-of-range positions need only
 * one side).
 */
export function quoteOtherAmount(
    sqrtPriceX96: bigint,
    sqrtLowerX96: bigint,
    sqrtUpperX96: bigint,
    typedIsToken0: boolean,
    typedAmount: bigint,
): bigint {
    if (typedAmount <= 0n) return 0n;
    const [sLow, sHigh] = sqrtLowerX96 < sqrtUpperX96
        ? [sqrtLowerX96, sqrtUpperX96]
        : [sqrtUpperX96, sqrtLowerX96];
    if (sLow >= sHigh) return 0n;
    if (typedIsToken0) {
        // Below range: only token0 contributes, token1 = 0.
        if (sqrtPriceX96 <= sLow) return 0n;
        // Above range: token0 typed is "wasted" on the live ratio side; UI
        // returns 0 so the user notices their range is out of bounds.
        if (sqrtPriceX96 >= sHigh) return 0n;
        const L = getLiquidityForAmount0(sqrtPriceX96, sHigh, typedAmount);
        return getAmount1ForLiquidity(sLow, sqrtPriceX96, L);
    }
    if (sqrtPriceX96 >= sHigh) return 0n;
    if (sqrtPriceX96 <= sLow) return 0n;
    const L = getLiquidityForAmount1(sLow, sqrtPriceX96, typedAmount);
    return getAmount0ForLiquidity(sqrtPriceX96, sHigh, L);
}

/**
 * Compute the liquidity placed by depositing amount0 + amount1 across the
 * range [sqrtA, sqrtB] given the current sqrtPriceX96. Mirrors
 * LiquidityAmounts.getLiquidityForAmounts.
 */
export function getLiquidityForAmounts(
    sqrtPriceX96: bigint,
    sqrtAX96: bigint,
    sqrtBX96: bigint,
    amount0: bigint,
    amount1: bigint,
): bigint {
    const [a, b] = sqrtAX96 < sqrtBX96 ? [sqrtAX96, sqrtBX96] : [sqrtBX96, sqrtAX96];
    if (sqrtPriceX96 <= a) {
        return getLiquidityForAmount0(a, b, amount0);
    }
    if (sqrtPriceX96 < b) {
        const l0 = getLiquidityForAmount0(sqrtPriceX96, b, amount0);
        const l1 = getLiquidityForAmount1(a, sqrtPriceX96, amount1);
        return l0 < l1 ? l0 : l1;
    }
    return getLiquidityForAmount1(a, b, amount1);
}

/** Amount0 consumed by a position of `liquidity` over [sqrtA, sqrtB]. */
function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
    const [a, b] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
    return ((liquidity * Q96 * (b - a)) / b) / a;
}

/** Amount1 consumed by a position of `liquidity` over [sqrtA, sqrtB]. */
function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
    const [a, b] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
    return (liquidity * (b - a)) / Q96;
}

/**
 * Inverse of getLiquidityForAmounts: given a placed liquidity + current
 * sqrtPrice + range, return the (amount0, amount1) actually consumed.
 * Use these as amount0Desired / amount1Desired on mint so the slippage
 * minimum can be tight without tripping the V3 core's M0/M1 revert.
 */
export function getAmountsForLiquidity(
    sqrtPriceX96: bigint,
    sqrtAX96: bigint,
    sqrtBX96: bigint,
    liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
    const [a, b] = sqrtAX96 < sqrtBX96 ? [sqrtAX96, sqrtBX96] : [sqrtBX96, sqrtAX96];
    if (sqrtPriceX96 <= a) {
        return { amount0: getAmount0ForLiquidity(a, b, liquidity), amount1: 0n };
    }
    if (sqrtPriceX96 < b) {
        return {
            amount0: getAmount0ForLiquidity(sqrtPriceX96, b, liquidity),
            amount1: getAmount1ForLiquidity(a, sqrtPriceX96, liquidity),
        };
    }
    return { amount0: 0n, amount1: getAmount1ForLiquidity(a, b, liquidity) };
}

/**
 * Bit-exact port of Uniswap V3 TickMath.getSqrtRatioAtTick. Reproduces the
 * on-chain magic-constant cascade so the sqrtX96 we feed into
 * getLiquidityForAmounts matches what the v3-pool will compute internally
 * to the last bit. Float-based versions (Math.pow + scale48) drift by ~1e18
 * units at typical ticks, which propagates through liquidity / amount
 * calculations and trips amount{0,1}Min on mint by tens of bps.
 */
const UINT256_MAX = (1n << 256n) - 1n;

export function getSqrtRatioAtTick(tick: number): bigint {
    const absTick = BigInt(tick < 0 ? -tick : tick);
    if (absTick > BigInt(MAX_TICK)) throw new Error("T");

    let ratio: bigint =
        (absTick & 0x1n) !== 0n
            ? 0xfffcb933bd6fad37aa2d162d1a594001n
            : 0x100000000000000000000000000000000n;
    if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
    if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
    if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
    if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
    if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
    if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
    if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
    if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
    if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
    if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
    if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
    if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
    if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
    if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
    if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
    if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
    if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
    if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
    if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

    if (tick > 0) ratio = UINT256_MAX / ratio;

    // Divide by 1<<32 rounding up so getTickAtSqrtRatio of the output is
    // consistent with the input tick (matches the on-chain rounding rule).
    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

