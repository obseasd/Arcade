// Public surface of the V4 math helpers. Re-exports the TickMath +
// LiquidityAmounts ports and adds one composite helper used directly by the
// launch wizard.

export {
    MIN_TICK,
    MAX_TICK,
    MIN_SQRT_PRICE,
    MAX_SQRT_PRICE,
    getSqrtPriceAtTick,
    getTickAtSqrtPrice,
    floorTick,
    maxUsableTick,
    minUsableTick,
    singleSidedRange,
} from "./tickMath";

export {
    getLiquidityForAmount0,
    getLiquidityForAmount1,
    getLiquidityForSingleSided,
} from "./liquidityAmounts";

import { getSqrtPriceAtTick, getTickAtSqrtPrice, singleSidedRange } from "./tickMath";
import { getLiquidityForSingleSided } from "./liquidityAmounts";

/**
 * Compute every argument needed to call `ArcadeV4Launchpad.initializePool`
 * given the user-facing launch params.
 *
 * Inputs:
 *   - sqrtPriceX96: the starting sqrtPrice (Q64.96). For pump.fun-style
 *     launches we typically start the pool at a tick that prices the launch
 *     token significantly above zero so the early buyers move the price up.
 *     Frontends usually derive this from a target FDV.
 *   - tokenIsCurrency0: from `ArcadeV4Launchpad.previewPosition(token, tick)`.
 *   - poolAllocation: from `ArcadeV4Launchpad.poolAllocation(token)` - the
 *     amount of launch token that will be locked into the pool (= total
 *     supply minus the creator allocation).
 *   - tickSpacing: 200 (1% fee tier).
 */
export function quoteInitializePool(params: {
    sqrtPriceX96: bigint;
    tokenIsCurrency0: boolean;
    poolAllocation: bigint;
    tickSpacing: number;
}): { liquidityDelta: bigint; tickLower: number; tickUpper: number; currentTick: number } {
    const currentTick = getTickAtSqrtPrice(params.sqrtPriceX96);
    const { tickLower, tickUpper } = singleSidedRange(
        params.tokenIsCurrency0,
        currentTick,
        params.tickSpacing,
    );
    const sqrtPriceLower = getSqrtPriceAtTick(tickLower);
    const sqrtPriceUpper = getSqrtPriceAtTick(tickUpper);
    const liquidityDelta = getLiquidityForSingleSided(
        params.tokenIsCurrency0,
        sqrtPriceLower,
        sqrtPriceUpper,
        params.poolAllocation,
    );
    return { liquidityDelta, tickLower, tickUpper, currentTick };
}
