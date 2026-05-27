// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ArcadeV3PriceMath
 * @notice Helpers to seed a fresh Uniswap V3 pool at the price implied by the
 *         bonding curve at migration. We only need to compute the initial
 *         `sqrtPriceX96` and the full-range ticks; all subsequent V3 math is
 *         handled inside the pool itself.
 */
library ArcadeV3PriceMath {
    /// @dev Uniswap V3 global tick bounds.
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    /**
     * @notice Encodes the price sqrt(amount1/amount0) as a Q64.96 value, the
     * format Uniswap V3 expects for pool initialization.
     *
     * Derivation:
     *   sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96
     *               = sqrt( (amount1 * 2^192) / amount0 )
     * We compute the inner ratio in Q192 with a 512-bit-safe mulDiv, then take
     * its integer sqrt — sqrt of a Q192 number yields a Q96 number directly.
     *
     * @param amount1 reserve of token1 (the higher-sorted address)
     * @param amount0 reserve of token0 (the lower-sorted address)
     */
    function encodeSqrtPriceX96(uint256 amount1, uint256 amount0)
        internal
        pure
        returns (uint160 sqrtPriceX96)
    {
        require(amount0 > 0 && amount1 > 0, "ZERO_RESERVE");
        // ratioX192 = amount1 * 2^192 / amount0  (full precision, no overflow)
        uint256 ratioX192 = Math.mulDiv(amount1, 1 << 192, amount0);
        uint256 s = Math.sqrt(ratioX192);
        require(s <= type(uint160).max, "PRICE_OVERFLOW");
        sqrtPriceX96 = uint160(s);
    }

    /**
     * @notice Returns the widest full-range tick bounds aligned to `tickSpacing`.
     * A full-range V3 position behaves like a V2 position (liquidity across the
     * entire price curve), which is what we want for a migrated launchpad token.
     */
    function fullRangeTicks(int24 tickSpacing)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        tickLower = (MIN_TICK / tickSpacing) * tickSpacing;
        tickUpper = (MAX_TICK / tickSpacing) * tickSpacing;
    }
}
