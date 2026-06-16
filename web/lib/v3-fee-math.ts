/**
 * Uniswap V3 fee growth math, ported to bigint.
 *
 * Why this exists: NPM.positions(tokenId).tokensOwed0/1 only reflects
 * fees that have been "realised" into the position state via a touch
 * (a swap traversing the tick range, increase/decrease/collect calls,
 * etc). Between touches, fees keep accumulating against the pool's
 * feeGrowthGlobal0/1X128 and are recoverable on the next touch, but
 * `tokensOwed` stays stale. The UI "Total earned" row would read
 * "0 USDC + 0 ETH" for a position that's genuinely earning fees, which
 * confuses the user.
 *
 * The functions here reproduce the calculation Uniswap's UI does to
 * surface its "Unclaimed fees" tile. Specifically:
 *   1) Compute feeGrowthInside0/1 from the pool's global + tick data
 *      using the standard V3 inside-vs-outside math.
 *   2) Subtract the position's `feeGrowthInside0/1LastX128` snapshot
 *      and multiply by liquidity to get the unrealised delta since
 *      the last touch.
 *   3) Add `tokensOwed0/1` (the already-realised portion) to land on
 *      the total amount currently recoverable from the position.
 *
 * All arithmetic is mod 2^256 to mirror Solidity's overflow rules.
 * Subtractions on uintX128 quantities deliberately wrap on underflow:
 * V3's tick feeGrowthOutside fields can hold values from after the
 * tick was last initialised, which can be greater than the "global"
 * if the tick was crossed early in the pool's life. Solidity treats
 * this as unsigned subtraction which wraps; we replicate.
 */

const MAX_UINT256 = (1n << 256n) - 1n;
const Q128 = 1n << 128n;

/** Unsigned subtraction modulo 2^256, matching Solidity uint256 wrap. */
function subWrap256(a: bigint, b: bigint): bigint {
    return (a - b) & MAX_UINT256;
}

/** Compute feeGrowthInside for one side of the pair. See
 *  Uniswap V3 Pool.sol Tick.getFeeGrowthInside. */
function feeGrowthInside(
    currentTick: number,
    tickLower: number,
    tickUpper: number,
    feeGrowthGlobalX128: bigint,
    lowerFeeGrowthOutsideX128: bigint,
    upperFeeGrowthOutsideX128: bigint,
): bigint {
    let feeGrowthBelow: bigint;
    if (currentTick >= tickLower) {
        feeGrowthBelow = lowerFeeGrowthOutsideX128;
    } else {
        feeGrowthBelow = subWrap256(feeGrowthGlobalX128, lowerFeeGrowthOutsideX128);
    }
    let feeGrowthAbove: bigint;
    if (currentTick < tickUpper) {
        feeGrowthAbove = upperFeeGrowthOutsideX128;
    } else {
        feeGrowthAbove = subWrap256(feeGrowthGlobalX128, upperFeeGrowthOutsideX128);
    }
    return subWrap256(
        subWrap256(feeGrowthGlobalX128, feeGrowthBelow),
        feeGrowthAbove,
    );
}

export interface PendingFeesInputs {
    /** Current tick from pool.slot0().tick. */
    currentTick: number;
    tickLower: number;
    tickUpper: number;
    feeGrowthGlobal0X128: bigint;
    feeGrowthGlobal1X128: bigint;
    /** pool.ticks(tickLower).feeGrowthOutside0X128 */
    lowerFeeGrowthOutside0X128: bigint;
    lowerFeeGrowthOutside1X128: bigint;
    /** pool.ticks(tickUpper).feeGrowthOutside0X128 */
    upperFeeGrowthOutside0X128: bigint;
    upperFeeGrowthOutside1X128: bigint;
    /** NPM.positions(tokenId).liquidity */
    liquidity: bigint;
    /** NPM.positions(tokenId).feeGrowthInside0LastX128 / 1LastX128 */
    feeGrowthInside0LastX128: bigint;
    feeGrowthInside1LastX128: bigint;
    /** NPM.positions(tokenId).tokensOwed0 / 1 */
    tokensOwed0: bigint;
    tokensOwed1: bigint;
}

/** Returns the live pending fees on both sides, in raw token units. */
export function computePendingFees(inputs: PendingFeesInputs): {
    fees0: bigint;
    fees1: bigint;
} {
    const inside0 = feeGrowthInside(
        inputs.currentTick,
        inputs.tickLower,
        inputs.tickUpper,
        inputs.feeGrowthGlobal0X128,
        inputs.lowerFeeGrowthOutside0X128,
        inputs.upperFeeGrowthOutside0X128,
    );
    const inside1 = feeGrowthInside(
        inputs.currentTick,
        inputs.tickLower,
        inputs.tickUpper,
        inputs.feeGrowthGlobal1X128,
        inputs.lowerFeeGrowthOutside1X128,
        inputs.upperFeeGrowthOutside1X128,
    );
    const delta0 = subWrap256(inside0, inputs.feeGrowthInside0LastX128);
    const delta1 = subWrap256(inside1, inputs.feeGrowthInside1LastX128);
    // mulDiv by 2^128. Liquidity is uint128 so the product fits
    // comfortably inside uint256.
    const unrealised0 = (delta0 * inputs.liquidity) / Q128;
    const unrealised1 = (delta1 * inputs.liquidity) / Q128;
    return {
        fees0: inputs.tokensOwed0 + unrealised0,
        fees1: inputs.tokensOwed1 + unrealised1,
    };
}
