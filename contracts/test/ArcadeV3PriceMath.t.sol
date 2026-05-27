// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcadeV3PriceMath} from "../src/v3/ArcadeV3PriceMath.sol";

contract PriceMathHarness {
    function encode(uint256 a1, uint256 a0) external pure returns (uint160) {
        return ArcadeV3PriceMath.encodeSqrtPriceX96(a1, a0);
    }

    function ticks(int24 spacing) external pure returns (int24 lo, int24 hi) {
        return ArcadeV3PriceMath.fullRangeTicks(spacing);
    }
}

contract ArcadeV3PriceMathTest is Test {
    PriceMathHarness math;

    function setUp() public {
        math = new PriceMathHarness();
    }

    function test_equalReservesGives1to1() public view {
        // amount1 == amount0 => price 1.0 => sqrtPriceX96 == 2^96
        uint160 sp = math.encode(1e18, 1e18);
        assertEq(uint256(sp), 1 << 96, "sqrtPrice of 1.0 is 2^96");
    }

    function test_4xPriceGives2xSqrt() public view {
        // price = amount1/amount0 = 4 => sqrt = 2 => sqrtPriceX96 = 2 * 2^96
        uint160 sp = math.encode(4e18, 1e18);
        assertApproxEqAbs(uint256(sp), 2 * (1 << 96), 2, "sqrt(4) = 2");
    }

    function test_handlesAsymmetricDecimals() public view {
        // Typical migration: ~20000e6 USDC vs 200_000_000e18 tokens, both orderings.
        uint160 sp = math.encode(20_000e6, 200_000_000e18);
        assertGt(uint256(sp), 0);
        sp = math.encode(200_000_000e18, 20_000e6);
        assertGt(uint256(sp), 0);
    }

    function test_fullRangeTicksAligned() public view {
        (int24 lo, int24 hi) = math.ticks(200); // 1% fee tier spacing
        assertEq(lo % 200, 0, "lower aligned");
        assertEq(hi % 200, 0, "upper aligned");
        assertEq(lo, -887200);
        assertEq(hi, 887200);
    }
}
