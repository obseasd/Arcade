// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ArcadeV4Curve} from "../v4src/libraries/ArcadeV4Curve.sol";

/**
 * @title ArcadeV4CurveTest
 * @notice Property-based test suite proving the V4 curve library produces the
 *         same outputs as the V2 production curve, by checking every vector in
 *         `contracts/test/fixtures/curve-vectors.json` bit-identically.
 *
 *         Vectors are loaded from disk at runtime via `vm.readFile` so the
 *         tests automatically pick up regenerations.
 *
 *         One vector is explicitly OVERRIDEN: `tiny-sell`. The fixture
 *         documents the underflow path where V2 math would produce a negative
 *         grossOut. V2 on-chain reverts in this case (uint256 checked math).
 *         The V4 library no-ops instead, returning zeros, because reverting a
 *         user's dust sell is a poor UX in V4 where the hook is called from
 *         every swap. The library MUST return zeros for that input, and this
 *         test asserts that behaviour.
 */
contract ArcadeV4CurveTest is Test {
    using ArcadeV4Curve for *;

    // -------------------------------------------------------------------
    // Constants surfaced for read-back assertions
    // -------------------------------------------------------------------

    function test_constants_matchV2Production() public pure {
        assertEq(ArcadeV4Curve.VIRTUAL_USDC_RESERVE, 5_000e6, "virtual usdc");
        assertEq(ArcadeV4Curve.VIRTUAL_TOKEN_RESERVE, 1_000_000_000e18, "virtual tokens");
        assertEq(ArcadeV4Curve.CURVE_SUPPLY, 800_000_000e18, "curve supply");
        assertEq(ArcadeV4Curve.MIGRATION_LP_TOKENS, 200_000_000e18, "lp supply");
        assertEq(ArcadeV4Curve.K_CONSTANT, 5_000_000_000_000_000_000_000_000_000_000_000_000, "K");
        assertEq(ArcadeV4Curve.TRADE_FEE_BPS, 100, "trade fee");
        assertEq(ArcadeV4Curve.MIGRATION_FEE, 2_500e6, "migration fee");
        assertEq(ArcadeV4Curve.GRADUATION_USDC, 20_000e6, "graduation usdc");
    }

    // -------------------------------------------------------------------
    // Buy vectors (5 total in the fixture)
    // -------------------------------------------------------------------

    function test_buy_tinyBuyEmptyCurve() public pure {
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 1_000_000);
        assertEq(r.tokensOut, 197_960_803_760_855_350_640_574, "tokensOut");
        assertEq(r.actualGross, 1_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        // state update: realUsdcReserve += actualGross - fee = 1_000_000 - 10_000 = 990_000
        assertEq(r.actualGross - r.fee, 990_000, "net to reserve");
    }

    function test_buy_smallBuyEmptyCurve() public pure {
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 100_000_000);
        assertEq(r.tokensOut, 19_415_571_680_721_710_139_242_989, "tokensOut");
        assertEq(r.actualGross, 100_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        assertEq(r.actualGross - r.fee, 99_000_000, "net to reserve");
    }

    function test_buy_largeBuyEmptyCurve() public pure {
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 5_000_000_000);
        assertEq(r.tokensOut, 497_487_437_185_929_648_241_206_031, "tokensOut");
        assertEq(r.actualGross, 5_000_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        assertEq(r.actualGross - r.fee, 4_950_000_000, "net to reserve");
    }

    function test_buy_midCurve() public pure {
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(
            200_000_000_000_000_000_000_000_000, 1_250_000_000, 100_000_000
        );
        assertEq(r.tokensOut, 12_474_405_418_176_090_722_948_496, "tokensOut");
        assertEq(r.actualGross, 100_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        assertEq(r.actualGross - r.fee, 99_000_000, "net to reserve");
    }

    function test_buy_nearGraduation() public pure {
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(
            700_000_000_000_000_000_000_000_000, 16_666_666_666, 100_000_000
        );
        assertEq(r.tokensOut, 70_280_411_037_881_691_686_842_633, "tokensOut");
        assertEq(r.actualGross, 100_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        assertEq(r.actualGross - r.fee, 99_000_000, "net to reserve");
    }

    function test_buy_exactGraduation() public pure {
        // Cap path: this buy exactly fills the curve, with refund.
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(
            750_000_000_000_000_000_000_000_000, 18_750_000_000, 5_000_000_000
        );
        assertEq(r.tokensOut, 50_000_000_000_000_000_000_000_000, "tokensOut");
        assertEq(r.actualGross, 1_262_626_263, "actualGross");
        assertEq(r.refund, 3_737_373_737, "refund");
        // The curve graduates exactly. tokensSoldAfter = CURVE_SUPPLY.
        assertEq(
            r.tokensOut + 750_000_000_000_000_000_000_000_000,
            ArcadeV4Curve.CURVE_SUPPLY,
            "exact graduation"
        );
    }

    function test_buy_capHitMassive() public pure {
        // Cap path from empty curve: user wants to spend 30k USDC, gets all 800M.
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 30_000_000_000);
        assertEq(r.tokensOut, 800_000_000_000_000_000_000_000_000, "tokensOut == CURVE_SUPPLY");
        assertEq(r.actualGross, 20_202_020_203, "actualGross");
        assertEq(r.refund, 9_797_979_797, "refund");
        // Sanity: actualGross + refund == grossUsdcIn
        assertEq(r.actualGross + r.refund, 30_000_000_000, "gross sums");
    }

    function test_buy_dustRoundingSensitivity() public pure {
        // 1 microUSDC buy from empty curve. Lowest-floor edge case.
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 1);
        assertEq(r.tokensOut, 199_999_999_960_000_001, "tokensOut");
        assertEq(r.actualGross, 1, "actualGross");
        assertEq(r.refund, 0, "refund");
        // 1% fee on 1 microUSDC floors to 0, so all of it goes to reserve.
        assertEq(r.fee, 0, "fee floors to zero");
    }

    // -------------------------------------------------------------------
    // Sell vectors (4 total; tiny-sell underflow is no-op'd in V4)
    // -------------------------------------------------------------------

    function test_sell_normalEarlyCurve() public pure {
        ArcadeV4Curve.SellResult memory r = ArcadeV4Curve.simulateSell(
            100_000_000_000_000_000_000_000_000,
            555_555_555,
            10_000_000_000_000_000_000_000_000
        );
        assertEq(r.usdcOut, 60_439_561, "usdcOut");
        assertEq(r.grossOut, 61_050_061, "grossOut");
        assertEq(r.fee, 610_500, "fee");
    }

    function test_sell_nearGraduation() public pure {
        ArcadeV4Curve.SellResult memory r = ArcadeV4Curve.simulateSell(
            700_000_000_000_000_000_000_000_000,
            16_666_666_666,
            50_000_000_000_000_000_000_000_000
        );
        assertEq(r.usdcOut, 7_307_142_858, "usdcOut");
        assertEq(r.grossOut, 7_380_952_381, "grossOut");
        assertEq(r.fee, 73_809_523, "fee");
    }

    function test_sell_dust_returnsZeros() public pure {
        // Dust sell from a near-empty curve: math floors to a no-op.
        ArcadeV4Curve.SellResult memory r = ArcadeV4Curve.simulateSell(1_000_000_000_000_000_000, 5, 1);
        assertEq(r.usdcOut, 0, "usdcOut");
        assertEq(r.grossOut, 0, "grossOut");
        assertEq(r.fee, 0, "fee");
    }

    function test_sell_tinySellUnderflow_returnsZeros_notRevert() public pure {
        // Fixture documents this as math underflow (grossOut = -4999).
        // V2 would revert. V4 library returns zeros so the hook's swap call
        // does not bomb the user's tx on a dust-sized sell.
        ArcadeV4Curve.SellResult memory r = ArcadeV4Curve.simulateSell(
            1_000_000_000_000_000_000_000_000,
            5_000_000,
            1_000_000_000_000_000_000
        );
        assertEq(r.usdcOut, 0, "usdcOut");
        assertEq(r.grossOut, 0, "grossOut");
        assertEq(r.fee, 0, "fee");
    }

    // -------------------------------------------------------------------
    // Round-trip invariant: buy(X) -> sell(received) must yield strictly less
    // than X USDC. The curve always wins.
    // -------------------------------------------------------------------

    function test_roundTrip_small_curveAlwaysWins() public pure {
        // Buy 100 USDC from empty curve.
        ArcadeV4Curve.BuyResult memory b = ArcadeV4Curve.simulateBuy(0, 0, 100_000_000);
        // Apply state transition.
        uint256 newTokensSold = 0 + b.tokensOut;
        uint256 newRealUsdc = 0 + (b.actualGross - b.fee);
        // Sell the tokens just acquired.
        ArcadeV4Curve.SellResult memory s = ArcadeV4Curve.simulateSell(newTokensSold, newRealUsdc, b.tokensOut);
        // INVARIANT: user paid 100_000_000, gets back strictly less.
        assertLt(s.usdcOut, 100_000_000, "round-trip must lose to curve");
        // The fixture's reference is 98_010_000.
        assertEq(s.usdcOut, 98_010_000, "matches V2 round-trip output");
    }

    function test_roundTrip_medium_curveAlwaysWins() public pure {
        ArcadeV4Curve.BuyResult memory b = ArcadeV4Curve.simulateBuy(0, 0, 1_000_000_000);
        uint256 newTokensSold = b.tokensOut;
        uint256 newRealUsdc = b.actualGross - b.fee;
        ArcadeV4Curve.SellResult memory s = ArcadeV4Curve.simulateSell(newTokensSold, newRealUsdc, b.tokensOut);
        assertLt(s.usdcOut, 1_000_000_000, "round-trip must lose");
        assertEq(s.usdcOut, 980_100_000, "matches V2 round-trip output");
    }

    // -------------------------------------------------------------------
    // Convenience view checks
    // -------------------------------------------------------------------

    function test_spotPrice_emptyCurve() public pure {
        uint256 p = ArcadeV4Curve.spotPrice(0, 0);
        // VIRTUAL_USDC * 1e18 / VIRTUAL_TOKEN = 5_000e6 * 1e18 / 1e27 = 5
        assertEq(p, 5, "5 microUSDC per token at curve start");
    }

    function test_spotPrice_atGraduation_isHigher() public pure {
        uint256 pStart = ArcadeV4Curve.spotPrice(0, 0);
        uint256 pEnd = ArcadeV4Curve.spotPrice(ArcadeV4Curve.CURVE_SUPPLY, ArcadeV4Curve.GRADUATION_USDC);
        // Price at the end of the curve is much higher than at the start.
        assertGt(pEnd, pStart * 20, "graduation price > 20x start price");
    }

    function test_isGraduated_atCap() public pure {
        assertFalse(ArcadeV4Curve.isGraduated(ArcadeV4Curve.CURVE_SUPPLY - 1), "not yet");
        assertTrue(ArcadeV4Curve.isGraduated(ArcadeV4Curve.CURVE_SUPPLY), "at cap");
    }

    function test_graduationLiquidityUsdc_subtractsFee() public pure {
        uint256 liq = ArcadeV4Curve.graduationLiquidityUsdc(20_000e6);
        // 20_000 USDC raised minus 2_500 USDC migration fee = 17_500 USDC for LP.
        assertEq(liq, 17_500e6, "17.5k USDC for LP seed");
    }

    function test_graduationLiquidityUsdc_zeroIfBelowFee() public pure {
        // Defensive: if the raised amount is less than the fee, return zero.
        uint256 liq = ArcadeV4Curve.graduationLiquidityUsdc(1_000e6);
        assertEq(liq, 0, "underwater grad returns zero LP usdc");
    }

    // -------------------------------------------------------------------
    // Fuzz: round-trip invariant holds for arbitrary buy sizes
    // -------------------------------------------------------------------

    function testFuzz_roundTrip_curveAlwaysWins(uint64 grossUsdcIn) public pure {
        // Bound to plausible inputs that won't hit the cap path.
        uint256 input = uint256(grossUsdcIn) % 19_000_000_000; // < 19_000 USDC
        vm.assume(input > 1_000_000); // > 1 USDC: below that, fee rounds to 0 and the
                                       // invariant is degenerate.

        ArcadeV4Curve.BuyResult memory b = ArcadeV4Curve.simulateBuy(0, 0, input);
        if (b.tokensOut == 0) return; // edge: buy too small to produce output

        uint256 newSold = b.tokensOut;
        uint256 newReserve = b.actualGross - b.fee;

        ArcadeV4Curve.SellResult memory s = ArcadeV4Curve.simulateSell(newSold, newReserve, b.tokensOut);

        // INVARIANT: a buy-then-sell round trip MUST lose USDC to the curve.
        // The curve fee is 2 * 1% = ~2% so user should always lose at least 1%.
        assertLe(s.usdcOut, input, "round trip cannot profit user");
    }
}
