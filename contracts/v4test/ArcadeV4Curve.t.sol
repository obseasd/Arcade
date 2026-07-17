// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ArcadeV4Curve} from "../v4src/libraries/ArcadeV4Curve.sol";

/**
 * @title ArcadeV4CurveTest
 * @notice Vector suite pinning the V4 curve library's exact outputs. As of
 *         2026-07-17 the V4 curve DIVERGES from the V2 production launchpad:
 *         it is calibrated (VIRTUAL_USDC 5.8k, VIRTUAL_TOKEN 1.135B > 1B supply,
 *         CURVE_SUPPLY 806M) so a launch graduates opening the AMM at ~$60k FDV
 *         WITH price continuity (the seed price equals the curve's final
 *         marginal price -- see test_graduation_seedPriceEqualsMarginal_noCliff).
 *         Vectors are inline (recomputed on any recalibration), NOT read from
 *         the shared curve-vectors.json fixture, which stays pinned to V2.
 *
 *         Dust sells (`tiny-sell`) that would underflow to a negative grossOut
 *         no-op to zeros here (V2 on-chain reverts); reverting a user's dust
 *         sell is poor UX in V4 where the hook is called from every swap.
 */
contract ArcadeV4CurveTest is Test {
    using ArcadeV4Curve for *;

    // -------------------------------------------------------------------
    // Constants surfaced for read-back assertions
    // -------------------------------------------------------------------

    /// V4 curve constants. NOTE: the V4 curve DIVERGES from the V2 production
    /// launchpad as of 2026-07-17 -- CURVE_SUPPLY dropped 800M -> 711M so the
    /// token graduates at ~$60k FDV instead of ~$125k. VIRTUAL_USDC/TOKEN/K are
    /// unchanged, so every non-cap buy/sell is bit-identical; only the
    /// graduation cap moved earlier (start FDV still ~$5k, a ~12x curve).
    function test_constants_v4Curve() public pure {
        assertEq(ArcadeV4Curve.VIRTUAL_USDC_RESERVE, 5_800e6, "virtual usdc");
        // VIRTUAL_TOKEN_RESERVE is LARGER than TOTAL_SUPPLY (1B) on purpose:
        // the 135M excess is a formula-only virtual reserve (never minted) that
        // makes the AMM seed land exactly on the curve's final price (0 cliff).
        assertEq(ArcadeV4Curve.VIRTUAL_TOKEN_RESERVE, 1_135_000_000e18, "virtual tokens");
        assertEq(ArcadeV4Curve.CURVE_SUPPLY, 806_000_000e18, "curve supply (calibrated)");
        assertEq(ArcadeV4Curve.MIGRATION_LP_TOKENS, 194_000_000e18, "lp supply");
        assertEq(ArcadeV4Curve.K_CONSTANT, 6_583_000_000_000_000_000_000_000_000_000_000_000, "K");
        assertEq(ArcadeV4Curve.TRADE_FEE_BPS, 100, "trade fee");
        assertEq(ArcadeV4Curve.MIGRATION_FEE, 2_500e6, "migration fee");
        assertEq(ArcadeV4Curve.GRADUATION_USDC, 14_209e6, "graduation usdc (calibrated)");
    }

    // -------------------------------------------------------------------
    // Buy vectors (5 total in the fixture)
    // -------------------------------------------------------------------

    function test_buy_tinyBuyEmptyCurve() public pure {
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 1_000_000);
        assertEq(r.tokensOut, 193_699_696_086_357_673_431_604, "tokensOut");
        assertEq(r.actualGross, 1_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        // state update: realUsdcReserve += actualGross - fee = 1_000_000 - 10_000 = 990_000
        assertEq(r.actualGross - r.fee, 990_000, "net to reserve");
    }

    function test_buy_smallBuyEmptyCurve() public pure {
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 100_000_000);
        assertEq(r.tokensOut, 19_048_143_753_178_504_831_327_344, "tokensOut");
        assertEq(r.actualGross, 100_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        assertEq(r.actualGross - r.fee, 99_000_000, "net to reserve");
    }

    function test_buy_largeBuyEmptyCurve() public pure {
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 5_000_000_000);
        assertEq(r.tokensOut, 522_627_906_976_744_186_046_511_628, "tokensOut");
        assertEq(r.actualGross, 5_000_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        assertEq(r.actualGross - r.fee, 4_950_000_000, "net to reserve");
    }

    function test_buy_midCurve() public pure {
        // Reserve is the consistent value at 200M sold: K/(V_T-200M) - V_U.
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(
            200_000_000_000_000_000_000_000_000, 1_240_641_711, 100_000_000
        );
        assertEq(r.tokensOut, 12_964_936_271_575_883_284_544_277, "tokensOut");
        assertEq(r.actualGross, 100_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        assertEq(r.actualGross - r.fee, 99_000_000, "net to reserve");
    }

    function test_buy_nearGraduation() public pure {
        // 800M sold (6M below the 806M cap). Consistent reserve = K/(V_T-800M)
        // - V_U. A 100 USDC buy gets ~1.68M tokens (< 6M remaining) -> normal
        // path, not a cap.
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(
            800_000_000_000_000_000_000_000_000, 13_850_746_268, 100_000_000
        );
        assertEq(r.tokensOut, 1_679_262_068_988_520_941_539_015, "tokensOut");
        assertEq(r.actualGross, 100_000_000, "actualGross");
        assertEq(r.refund, 0, "refund");
        assertEq(r.actualGross - r.fee, 99_000_000, "net to reserve");
    }

    function test_buy_exactGraduation() public pure {
        // Cap path: this buy exactly fills the curve to 806M, with refund.
        // 805M sold, consistent reserve = K/(V_T-805M) - V_U.
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(
            805_000_000_000_000_000_000_000_000, 14_148_484_848, 5_000_000_000
        );
        assertEq(r.tokensOut, 1_000_000_000_000_000_000_000_000, "tokensOut");
        assertEq(r.actualGross, 61_246_156, "actualGross");
        assertEq(r.refund, 4_938_753_844, "refund");
        // The curve graduates exactly. tokensSoldAfter = CURVE_SUPPLY.
        assertEq(
            r.tokensOut + 805_000_000_000_000_000_000_000_000,
            ArcadeV4Curve.CURVE_SUPPLY,
            "exact graduation"
        );
        assertEq(r.actualGross + r.refund, 5_000_000_000, "gross sums");
    }

    function test_buy_capHitMassive() public pure {
        // Cap path from empty curve: user wants to spend 30k USDC, gets all 806M.
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 30_000_000_000);
        assertEq(r.tokensOut, 806_000_000_000_000_000_000_000_000, "tokensOut == CURVE_SUPPLY");
        assertEq(r.actualGross, 14_352_644_992, "actualGross");
        assertEq(r.refund, 15_647_355_008, "refund");
        // Sanity: actualGross + refund == grossUsdcIn
        assertEq(r.actualGross + r.refund, 30_000_000_000, "gross sums");
    }

    function test_buy_dustRoundingSensitivity() public pure {
        // 1 microUSDC buy from empty curve. Lowest-floor edge case.
        ArcadeV4Curve.BuyResult memory r = ArcadeV4Curve.simulateBuy(0, 0, 1);
        assertEq(r.tokensOut, 195_689_655_138_674_198, "tokensOut");
        assertEq(r.actualGross, 1, "actualGross");
        assertEq(r.refund, 0, "refund");
        // 1% fee on 1 microUSDC floors to 0, so all of it goes to reserve.
        assertEq(r.fee, 0, "fee floors to zero");
    }

    // -------------------------------------------------------------------
    // Sell vectors (4 total; tiny-sell underflow is no-op'd in V4)
    // -------------------------------------------------------------------

    function test_sell_normalEarlyCurve() public pure {
        // 100M sold, consistent reserve = K/(V_T-100M) - V_U; sell 10M tokens.
        ArcadeV4Curve.SellResult memory r = ArcadeV4Curve.simulateSell(
            100_000_000_000_000_000_000_000_000,
            560_386_473,
            10_000_000_000_000_000_000_000_000
        );
        assertEq(r.usdcOut, 60_256_293, "usdcOut");
        assertEq(r.grossOut, 60_864_942, "grossOut");
        assertEq(r.fee, 608_649, "fee");
    }

    function test_sell_nearGraduation() public pure {
        // 800M sold, consistent reserve = K/(V_T-800M) - V_U; sell 50M tokens.
        ArcadeV4Curve.SellResult memory r = ArcadeV4Curve.simulateSell(
            800_000_000_000_000_000_000_000_000,
            13_850_746_268,
            50_000_000_000_000_000_000_000_000
        );
        assertEq(r.usdcOut, 2_526_524_521, "usdcOut");
        assertEq(r.grossOut, 2_552_044_970, "grossOut");
        assertEq(r.fee, 25_520_449, "fee");
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
        // VIRTUAL_USDC * 1e18 / VIRTUAL_TOKEN = 5_800e6 * 1e18 / 1_135_000_000e18
        // = 5. Start FDV = 5 * 1e9 / 1e6 = $5,000.
        assertEq(p, 5, "5 microUSDC per token at curve start");
    }

    function test_spotPrice_atGraduation_isHigher() public pure {
        uint256 pStart = ArcadeV4Curve.spotPrice(0, 0);
        uint256 pEnd = ArcadeV4Curve.spotPrice(ArcadeV4Curve.CURVE_SUPPLY, ArcadeV4Curve.GRADUATION_USDC);
        // Price at graduation is much higher than at the start. The retuned
        // curve is ~12x start->graduation (was ~25x), so assert > 10x.
        assertGt(pEnd, pStart * 10, "graduation price > 10x start price");
    }

    function test_isGraduated_atCap() public pure {
        assertFalse(ArcadeV4Curve.isGraduated(ArcadeV4Curve.CURVE_SUPPLY - 1), "not yet");
        assertTrue(ArcadeV4Curve.isGraduated(ArcadeV4Curve.CURVE_SUPPLY), "at cap");
    }

    // Consistent real reserve at a given tokensSold: K/(V_T - sold) - V_U.
    function _reserveAt(uint256 sold) internal pure returns (uint256) {
        return ArcadeV4Curve.K_CONSTANT / (ArcadeV4Curve.VIRTUAL_TOKEN_RESERVE - sold)
            - ArcadeV4Curve.VIRTUAL_USDC_RESERVE;
    }

    /// The whole point of the 2026-07-17 calibration: the AMM seeds at the
    /// curve's FINAL MARGINAL PRICE, so the pool opens exactly where the curve
    /// ended -- zero graduation cliff, no free discount for the first buyer.
    /// This works because VIRTUAL_TOKEN_RESERVE > TOTAL_SUPPLY (pump.fun's
    /// method): seeding all MIGRATION_LP_TOKENS with the real raise lands on the
    /// marginal price. If someone "rounds" VIRTUAL_TOKEN_RESERVE back to 1B this
    /// test fails, guarding the invariant.
    function test_graduation_seedPriceEqualsMarginal_noCliff() public pure {
        uint256 realAtGrad = _reserveAt(ArcadeV4Curve.CURVE_SUPPLY);
        uint256 marginal = ArcadeV4Curve.spotPrice(ArcadeV4Curve.CURVE_SUPPLY, realAtGrad);
        uint256 lpUsdc = ArcadeV4Curve.graduationLiquidityUsdc(realAtGrad);
        uint256 seedPrice = (lpUsdc * 1e18) / ArcadeV4Curve.MIGRATION_LP_TOKENS;
        assertEq(seedPrice, marginal, "AMM opens at curve marginal price (0 cliff)");
        // And that price is the ~$60k open FDV target (60 microUSDC/token * 1B).
        assertEq(marginal, 60, "graduation marginal ~= $60k FDV");
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
