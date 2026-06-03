// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {ArcadeHook} from "../v4src/ArcadeHook.sol";
import {ArcadeV4Curve} from "../v4src/libraries/ArcadeV4Curve.sol";

import {PoolManager} from "v4-core/PoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {TestERC20} from "v4-core/test/TestERC20.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ArcadeHookSwapTest
 * @notice End-to-end curve buy / sell tests against the V4 ArcadeHook.
 *
 *         During the Curving phase the V4 swap path is rejected (V4 swap
 *         requires LP-backed liquidity; the curve has none). Traders use
 *         hook.buy / hook.sell which move USDC and launch tokens via plain
 *         ERC20 transferFrom + transfer, mirroring the V2 production
 *         launchpad's contract surface.
 *
 *         These tests prove:
 *           - PUMP mode buys: 50/50 fee split, V2-equivalent tokensOut.
 *           - CLANKER mode buys: 70/30 split, same curve math.
 *           - Sequential buys accumulate state; later buyers pay more per
 *             token (price discovery).
 *           - Round-trip buy -> sell loses USDC to the curve (matches V2
 *             curve-vectors fixture exactly: 100 USDC -> 98_010_000).
 *           - Cap-path buys revert with GraduationInProgress (deferred to
 *             Round 4).
 *           - During Curving the V4 swap router path reverts with
 *             LiquidityNotPermitted to force traders through hook.buy/sell.
 */
contract ArcadeHookSwapTest is Test {
    PoolManager pm;
    ArcadeHook hook;
    TestERC20 usdc;
    PoolSwapTest swapRouter;

    address constant LOCKED_VAULT = address(0xCAFE);
    address constant TREASURY = address(0xBEEF);
    address constant ESCROW = address(0xE5C);
    address constant OWNER = address(0x0123);
    address constant ALICE = address(0xA11CE);
    address constant CREATOR = address(0xC0FFEE);

    uint160 internal constant TARGET_FLAGS = uint160(0x3ECE);

    function setUp() public {
        pm = new PoolManager(address(this));
        usdc = new TestERC20(0);

        address hookAddr = address(uint160(0xBEEF0000 | TARGET_FLAGS));
        deployCodeTo(
            "ArcadeHook.sol:ArcadeHook",
            abi.encode(IPoolManager(address(pm)), Currency.wrap(address(usdc)), LOCKED_VAULT, TREASURY, ESCROW, OWNER),
            hookAddr
        );
        hook = ArcadeHook(hookAddr);

        swapRouter = new PoolSwapTest(pm);

        usdc.mint(CREATOR, 100_000e6);
        usdc.mint(ALICE, 100_000e6);

        vm.startPrank(CREATOR);
        usdc.approve(address(hook), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(ALICE);
        usdc.approve(address(hook), type(uint256).max);
        usdc.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Spawn a launch in PUMP mode.
    function _launchPump() internal returns (address tokenAddr, PoolKey memory key) {
        vm.prank(CREATOR);
        (tokenAddr,) = hook.createLaunch("PumpToken", "PUMP", "ipfs://demo", 0, address(0), 0, 0, 0);
        key = _buildKey(tokenAddr);
    }

    /// @dev CLANKER variant with 70/30 split.
    function _launchClanker() internal returns (address tokenAddr, PoolKey memory key) {
        vm.prank(CREATOR);
        (tokenAddr,) = hook.createLaunch("ClankerTok", "CLNK", "ipfs://demo", 1, address(0), 0, 0, 0);
        key = _buildKey(tokenAddr);
    }

    function _buildKey(address token) internal view returns (PoolKey memory) {
        address usdcAddr = address(usdc);
        (Currency c0, Currency c1) = usdcAddr < token
            ? (Currency.wrap(usdcAddr), Currency.wrap(token))
            : (Currency.wrap(token), Currency.wrap(usdcAddr));
        return PoolKey({currency0: c0, currency1: c1, fee: 10_000, tickSpacing: 200, hooks: IHooks(address(hook))});
    }

    // -------------------------------------------------------------------
    // PUMP mode buy: 50/50 fee split
    // -------------------------------------------------------------------

    function test_buy_pump_smallAmount_distributesFees50_50_andTransfersTokens() public {
        (address tokenAddr, PoolKey memory key) = _launchPump();

        uint256 amountIn = 100e6;
        ArcadeV4Curve.BuyResult memory expected = ArcadeV4Curve.simulateBuy(0, 0, amountIn);

        uint256 treasuryBefore = usdc.balanceOf(TREASURY);
        uint256 creatorBefore = usdc.balanceOf(CREATOR);
        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);

        vm.prank(ALICE);
        (uint256 tokensOut, uint256 actualGross) = hook.buy(tokenAddr, amountIn, 0);

        assertEq(tokensOut, expected.tokensOut, "tokensOut matches V2 fixture");
        assertEq(actualGross, expected.actualGross, "actualGross matches");

        assertEq(IERC20(tokenAddr).balanceOf(ALICE), expected.tokensOut, "alice received tokens");
        assertEq(aliceUsdcBefore - usdc.balanceOf(ALICE), expected.actualGross, "alice paid actualGross");

        uint256 expectedSide = expected.fee / 2;
        assertEq(usdc.balanceOf(TREASURY) - treasuryBefore, expectedSide, "treasury 50% of fee");
        assertEq(usdc.balanceOf(CREATOR) - creatorBefore, expectedSide, "creator 50% of fee");

        ArcadeHook.CurveState memory s = hook.getCurveState(key.toId());
        assertEq(s.tokensSold, expected.tokensOut, "state tokensSold tracked");
        assertEq(s.realUsdcReserve, expected.actualGross - expected.fee, "state realUsdcReserve tracked");
    }

    // -------------------------------------------------------------------
    // CLANKER mode (70/30)
    // -------------------------------------------------------------------

    function test_buy_clanker_distributesFees70_30() public {
        (address tokenAddr,) = _launchClanker();

        uint256 amountIn = 100e6;
        ArcadeV4Curve.BuyResult memory expected = ArcadeV4Curve.simulateBuy(0, 0, amountIn);

        uint256 treasuryBefore = usdc.balanceOf(TREASURY);
        uint256 creatorBefore = usdc.balanceOf(CREATOR);

        vm.prank(ALICE);
        hook.buy(tokenAddr, amountIn, 0);

        uint256 expectedTreasury = (expected.fee * 7_000) / 10_000;
        uint256 expectedCreator = expected.fee - expectedTreasury;
        assertEq(usdc.balanceOf(TREASURY) - treasuryBefore, expectedTreasury, "treasury 70% of fee");
        assertEq(usdc.balanceOf(CREATOR) - creatorBefore, expectedCreator, "creator 30% of fee");
    }

    // -------------------------------------------------------------------
    // Sequential buys accumulate state, prices rise
    // -------------------------------------------------------------------

    function test_buy_sequentialBuys_accumulateStateAndRaisePrice() public {
        (address tokenAddr, PoolKey memory key) = _launchPump();

        vm.prank(ALICE);
        (uint256 firstTokens,) = hook.buy(tokenAddr, 100e6, 0);

        vm.prank(ALICE);
        (uint256 secondTokens,) = hook.buy(tokenAddr, 100e6, 0);

        assertLt(secondTokens, firstTokens, "second buy yields fewer tokens (price rose)");

        ArcadeHook.CurveState memory s = hook.getCurveState(key.toId());
        assertEq(s.tokensSold, firstTokens + secondTokens, "state aggregate");
    }

    // -------------------------------------------------------------------
    // Round trip loses to the curve (V2 fixture invariant)
    // -------------------------------------------------------------------

    function test_buyThenSell_roundTripLosesToCurve() public {
        (address tokenAddr,) = _launchPump();

        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);
        vm.prank(ALICE);
        (uint256 tokensReceived,) = hook.buy(tokenAddr, 100e6, 0);

        vm.startPrank(ALICE);
        IERC20(tokenAddr).approve(address(hook), tokensReceived);
        uint256 usdcOut = hook.sell(tokenAddr, tokensReceived, 0);
        vm.stopPrank();

        // V2 round-trip fixture: 100 USDC -> 98_010_000 USDC back.
        assertEq(usdcOut, 98_010_000, "matches V2 round-trip vector");
        assertEq(usdc.balanceOf(ALICE), aliceUsdcBefore - 100e6 + 98_010_000, "alice net loss");
    }

    // -------------------------------------------------------------------
    // Graduation (Round 4)
    // -------------------------------------------------------------------

    function test_buy_capPath_graduatesPoolAndTakesMigrationFee() public {
        (address tokenAddr, PoolKey memory key) = _launchPump();

        uint256 treasuryBefore = usdc.balanceOf(TREASURY);
        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);

        vm.prank(ALICE);
        (uint256 tokensOut, uint256 actualGross) = hook.buy(tokenAddr, 30_000e6, 0);

        // Alice received the full CURVE_SUPPLY (cap path delivers maxOut).
        assertEq(tokensOut, ArcadeV4Curve.CURVE_SUPPLY, "alice gets full curve supply");
        // Per Round 1 fixture: cap-path buy from empty curve consumes
        // actualGross = 20_202_020_203 USDC.
        assertEq(actualGross, 20_202_020_203, "matches fixture actualGross");
        // Refund stays with alice automatically (we only transferFrom actualGross).
        assertEq(aliceUsdcBefore - usdc.balanceOf(ALICE), actualGross, "alice only paid actualGross");

        // Status is now Graduated. Curve state is at the cap.
        ArcadeHook.CurveState memory s = hook.getCurveState(key.toId());
        assertEq(uint256(s.status), 2, "status = Graduated");
        assertEq(s.tokensSold, ArcadeV4Curve.CURVE_SUPPLY, "tokensSold at cap");

        // Treasury received MIGRATION_FEE (plus its share of the curve trade
        // fee on the cap-filling buy). At MINIMUM treasuryBefore + 2_500e6.
        assertGe(
            usdc.balanceOf(TREASURY) - treasuryBefore, 2_500e6, "treasury at least migration fee"
        );
    }

    function test_buy_afterGraduation_revertsLiquidityNotPermitted() public {
        (address tokenAddr,) = _launchPump();

        // Graduate the pool first.
        vm.prank(ALICE);
        hook.buy(tokenAddr, 30_000e6, 0);

        // Further hook.buy calls should revert because the curve is closed.
        vm.prank(ALICE);
        vm.expectRevert(ArcadeHook.LiquidityNotPermitted.selector);
        hook.buy(tokenAddr, 100e6, 0);
    }

    function test_sell_afterGraduation_revertsLiquidityNotPermitted() public {
        (address tokenAddr,) = _launchPump();

        vm.prank(ALICE);
        hook.buy(tokenAddr, 30_000e6, 0);

        vm.startPrank(ALICE);
        IERC20(tokenAddr).approve(address(hook), type(uint256).max);
        vm.expectRevert(ArcadeHook.LiquidityNotPermitted.selector);
        hook.sell(tokenAddr, 1e18, 0);
        vm.stopPrank();
    }

    function test_v4Swap_afterGraduation_succeeds() public {
        (address tokenAddr, PoolKey memory key) = _launchPump();

        // Graduate.
        vm.prank(ALICE);
        hook.buy(tokenAddr, 30_000e6, 0);

        // Now a V4 swap through the canonical router should land at the
        // graduation-seeded pool. Alice already holds the launch tokens
        // from the cap-path buy; she sells some via the AMM.
        uint256 sellAmount = 1_000e18;
        vm.startPrank(ALICE);
        IERC20(tokenAddr).approve(address(swapRouter), type(uint256).max);
        bool zeroForOne = Currency.unwrap(key.currency0) != address(usdc);
        uint160 priceLimit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        BalanceDelta delta = swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(sellAmount), sqrtPriceLimitX96: priceLimit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        // The AMM produced a non-zero output on the USDC side.
        int128 usdcDelta = Currency.unwrap(key.currency0) == address(usdc) ? delta.amount0() : delta.amount1();
        assertGt(int256(usdcDelta), 0, "alice receives USDC from V4 AMM");
    }

    // -------------------------------------------------------------------
    // Slippage guards
    // -------------------------------------------------------------------

    function test_buy_slippage_revertsWhenMinTokensOutNotMet() public {
        (address tokenAddr,) = _launchPump();
        // Set min absurdly high; should revert before transferring USDC.
        vm.prank(ALICE);
        vm.expectRevert(ArcadeHook.ZeroAmount.selector); // reused for slippage
        hook.buy(tokenAddr, 100e6, type(uint256).max);
    }

    function test_sell_slippage_revertsWhenMinUsdcOutNotMet() public {
        (address tokenAddr,) = _launchPump();
        vm.prank(ALICE);
        (uint256 tokensReceived,) = hook.buy(tokenAddr, 100e6, 0);

        vm.startPrank(ALICE);
        IERC20(tokenAddr).approve(address(hook), tokensReceived);
        vm.expectRevert(ArcadeHook.ZeroAmount.selector);
        hook.sell(tokenAddr, tokensReceived, type(uint256).max);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------
    // Negative cases
    // -------------------------------------------------------------------

    function test_buy_revertsForUnregisteredToken() public {
        vm.prank(ALICE);
        vm.expectRevert(ArcadeHook.LaunchNotRegistered.selector);
        hook.buy(address(0xdead), 100e6, 0);
    }

    function test_buy_revertsOnZeroAmount() public {
        (address tokenAddr,) = _launchPump();
        vm.prank(ALICE);
        vm.expectRevert(ArcadeHook.ZeroAmount.selector);
        hook.buy(tokenAddr, 0, 0);
    }

    function test_buy_revertsWhenPaused() public {
        (address tokenAddr,) = _launchPump();
        vm.prank(OWNER);
        hook.pause();
        vm.prank(ALICE);
        vm.expectRevert();
        hook.buy(tokenAddr, 100e6, 0);
    }

    // -------------------------------------------------------------------
    // V4 swap path during Curving must revert
    // -------------------------------------------------------------------

    function test_v4Swap_duringCurving_revertsForceUsesHookBuy() public {
        (, PoolKey memory key) = _launchPump();

        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdc);
        uint160 priceLimit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;

        vm.prank(ALICE);
        vm.expectRevert(); // LiquidityNotPermitted wraps inside the manager
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(uint256(100e6)), sqrtPriceLimitX96: priceLimit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
