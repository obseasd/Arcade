// 1:1 TS port of @uniswap/v4-periphery's LiquidityAmounts library.
// Used by the V4 launch wizard to size `liquidityDelta` for initializePool
// given a known token amount + sqrtPrice range.
//
// Mirrors contracts/lib/v4-periphery/src/libraries/LiquidityAmounts.sol so
// our off-chain number matches what the on-chain modifyLiquidity will use.

const Q96 = 1n << 96n;
const UINT128_MAX = (1n << 128n) - 1n;

function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
    if (denominator === 0n) throw new Error("mulDiv: denominator is zero");
    return (a * b) / denominator;
}

function toUint128(x: bigint): bigint {
    if (x < 0n || x > UINT128_MAX) {
        throw new Error(`toUint128 overflow: ${x}`);
    }
    return x;
}

/**
 * Computes the amount of liquidity received for a given amount of token0 and
 * price range.
 *
 * Math: liquidity = amount0 * (sqrtA * sqrtB / Q96) / (sqrtB - sqrtA)
 */
export function getLiquidityForAmount0(
    sqrtPriceAX96: bigint,
    sqrtPriceBX96: bigint,
    amount0: bigint,
): bigint {
    if (sqrtPriceAX96 > sqrtPriceBX96) {
        [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
    }
    const intermediate = mulDiv(sqrtPriceAX96, sqrtPriceBX96, Q96);
    return toUint128(mulDiv(amount0, intermediate, sqrtPriceBX96 - sqrtPriceAX96));
}

/**
 * Computes the amount of liquidity received for a given amount of token1 and
 * price range.
 *
 * Math: liquidity = amount1 * Q96 / (sqrtB - sqrtA)
 */
export function getLiquidityForAmount1(
    sqrtPriceAX96: bigint,
    sqrtPriceBX96: bigint,
    amount1: bigint,
): bigint {
    if (sqrtPriceAX96 > sqrtPriceBX96) {
        [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
    }
    return toUint128(mulDiv(amount1, Q96, sqrtPriceBX96 - sqrtPriceAX96));
}

/**
 * Single-sided helper used by the launch wizard. Given the token amount the
 * launchpad will lock into the pool and the (lower, upper) tick range from
 * `previewPosition`, returns the `liquidityDelta` to pass into
 * `initializePool`.
 *
 * Caller provides the sqrtPrices of the bounds (use getSqrtPriceAtTick on
 * tickLower / tickUpper).
 */
export function getLiquidityForSingleSided(
    tokenIsCurrency0: boolean,
    sqrtPriceLowerX96: bigint,
    sqrtPriceUpperX96: bigint,
    tokenAmount: bigint,
): bigint {
    return tokenIsCurrency0
        ? getLiquidityForAmount0(sqrtPriceLowerX96, sqrtPriceUpperX96, tokenAmount)
        : getLiquidityForAmount1(sqrtPriceLowerX96, sqrtPriceUpperX96, tokenAmount);
}
