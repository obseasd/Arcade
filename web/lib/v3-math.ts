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
export const FEE_TICK_SPACING: Record<number, number> = {
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
export function priceToTick(price: number): number {
    if (!isFinite(price) || price <= 0) return 0;
    return Math.floor(Math.log(price) / Math.log(1.0001));
}

export function tickToPrice(tick: number): number {
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
export function roundTickDown(tick: number, spacing: number): number {
    const r = tick - (tick % spacing);
    return tick < 0 && tick % spacing !== 0 ? r - spacing : r;
}

export function roundTickUp(tick: number, spacing: number): number {
    const r = tick + (spacing - (tick % spacing));
    return tick % spacing === 0 ? tick : r;
}

/**
 * Clamp a tick to the global Uniswap V3 [MIN_TICK, MAX_TICK] domain.
 */
export function clampTick(tick: number): number {
    if (tick < MIN_TICK) return MIN_TICK;
    if (tick > MAX_TICK) return MAX_TICK;
    return tick;
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
        const min = roundTickUp(MIN_TICK, tickSpacing);
        const max = roundTickDown(MAX_TICK, tickSpacing);
        return { tickLower: min, tickUpper: max };
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
        tickLower: roundTickDown(clampTick(tickLow), tickSpacing),
        tickUpper: roundTickUp(clampTick(tickHigh), tickSpacing),
    };
}

/**
 * sqrtPriceX96 of a price = sqrt(price) * 2^96.
 * Used for createAndInitializePoolIfNecessary when a pool doesn't exist yet:
 * we have to seed the pool at the user's chosen initial price.
 */
export function encodeSqrtPriceX96(price: number): bigint {
    if (!isFinite(price) || price <= 0) return 0n;
    // price is token1/token0 in raw (decimals-adjusted). sqrt + scale.
    const sqrtPrice = Math.sqrt(price);
    // 2^96 doesn't fit in a JS number, so we scale via BigInt arithmetic.
    // sqrtPrice * 2^96 = sqrtPrice * 2^48 * 2^48
    const scale48 = 2 ** 48;
    const a = BigInt(Math.floor(sqrtPrice * scale48));
    const b = BigInt(scale48);
    return a * b;
}

/**
 * Mirror of Uniswap V3's LiquidityAmounts.getLiquidityForAmounts for the UI
 * preview. Float math, accurate enough for "you'll receive ~X liquidity".
 */
export function previewLiquidity(
    amount0: bigint,
    amount1: bigint,
    currentTick: number,
    tickLower: number,
    tickUpper: number,
): bigint {
    if (tickUpper <= tickLower) return 0n;
    const sqrtP = Math.sqrt(tickToPrice(currentTick));
    const sqrtA = Math.sqrt(tickToPrice(tickLower));
    const sqrtB = Math.sqrt(tickToPrice(tickUpper));

    // Below range: only token0
    if (currentTick < tickLower) {
        const num = Number(amount0) * (sqrtA * sqrtB);
        const den = sqrtB - sqrtA;
        if (den === 0) return 0n;
        return BigInt(Math.floor(num / den));
    }
    // Above range: only token1
    if (currentTick >= tickUpper) {
        const num = Number(amount1);
        const den = sqrtB - sqrtA;
        if (den === 0) return 0n;
        return BigInt(Math.floor(num / den));
    }
    // In range: choose the binding leg
    const l0 = (Number(amount0) * (sqrtP * sqrtB)) / (sqrtB - sqrtP || 1);
    const l1 = Number(amount1) / (sqrtP - sqrtA || 1);
    return BigInt(Math.floor(Math.min(l0, l1)));
}
