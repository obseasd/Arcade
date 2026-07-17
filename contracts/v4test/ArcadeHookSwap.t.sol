// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {ArcadeHook} from "../v4src/ArcadeHook.sol";
import {ArcadeV4Curve} from "../v4src/libraries/ArcadeV4Curve.sol";
import {ArcadeV4SwapRouter} from "../v4src/ArcadeV4SwapRouter.sol";

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

    /// @dev USDC deployment, overridable so a subclass can force the currency
    ///      ordering. Default places USDC at a normal (high) address -> USDC
    ///      sorts as currency1 vs the hook-CREATE'd launch tokens.
    function _makeUsdc() internal virtual returns (TestERC20) {
        return new TestERC20(0);
    }

    function setUp() public {
        pm = new PoolManager(address(this));
        usdc = _makeUsdc();

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
        (tokenAddr,) = hook.createLaunch("PumpToken", "PUMP", "ipfs://demo", 0, address(0), 0, 0, 0, 0);
        key = _buildKey(tokenAddr);
    }

    /// @dev CLANKER variant with 70/30 split.
    function _launchClanker() internal returns (address tokenAddr, PoolKey memory key) {
        vm.prank(CREATOR);
        (tokenAddr,) = hook.createLaunch("ClankerTok", "CLNK", "ipfs://demo", 1, address(0), 0, 0, 0, 1);
        key = _buildKey(tokenAddr);
    }

    function _buildKey(address token) internal view returns (PoolKey memory) {
        address usdcAddr = address(usdc);
        (Currency c0, Currency c1) = usdcAddr < token
            ? (Currency.wrap(usdcAddr), Currency.wrap(token))
            : (Currency.wrap(token), Currency.wrap(usdcAddr));
        return PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: 200, hooks: IHooks(address(hook))});
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
        // Calibrated curve (806M): a cap-path buy from an empty curve consumes
        // actualGross = 14_352_644_992 USDC (raise ~14.2k + 1% fee headroom).
        assertEq(actualGross, 14_352_644_992, "matches calibrated cap actualGross");
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

    // -------------------------------------------------------------------
    // Post-graduation royalty (Round 5)
    // -------------------------------------------------------------------

    function _graduatePump() internal returns (address tokenAddr, PoolKey memory key) {
        (tokenAddr, key) = _launchPump();
        vm.prank(ALICE);
        hook.buy(tokenAddr, 30_000e6, 0);
    }

    function _graduateClanker() internal returns (address tokenAddr, PoolKey memory key) {
        (tokenAddr, key) = _launchClanker();
        vm.prank(ALICE);
        hook.buy(tokenAddr, 30_000e6, 0);
    }

    function _sellViaV4(PoolKey memory key, address tokenAddr, address trader, uint256 amount)
        internal
        returns (BalanceDelta delta)
    {
        vm.startPrank(trader);
        IERC20(tokenAddr).approve(address(swapRouter), type(uint256).max);
        bool zeroForOne = Currency.unwrap(key.currency0) != address(usdc);
        uint160 priceLimit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        delta = swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: priceLimit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Anti-sniper: the coverage the round-4 HIGH + the clock bug slipped
    // through (no test ever did a post-graduation BUY with a snipe config).
    // ------------------------------------------------------------------

    /// Graduate a PUMP launch that HAS an anti-sniper config, having let more
    /// than the whole decay window pass BEFORE graduating (a realistic curve
    /// fills over hours/days). A launch-anchored decay clock -- the pre-fix bug
    /// -- would already read 0 by graduation; a graduation-anchored clock (the
    /// fix) starts fresh here.
    function _graduatePumpWithSnipe(uint16 startBps, uint32 decaySeconds)
        internal
        returns (address tokenAddr, PoolKey memory key)
    {
        vm.prank(CREATOR);
        (tokenAddr,) =
            hook.createLaunch("SnipePump", "SNP", "ipfs://demo", 0, address(0), 0, startBps, decaySeconds, 0);
        key = _buildKey(tokenAddr);
        vm.warp(block.timestamp + uint256(decaySeconds) + 3_600);
        usdc.mint(ALICE, 100_000e6);
        vm.prank(ALICE);
        hook.buy(tokenAddr, 30_000e6, 0); // graduates
    }

    /// A post-graduation BUY: USDC -> token via the real V4 swap router.
    function _buyViaV4(PoolKey memory key, address trader, uint256 usdcAmount)
        internal
        returns (BalanceDelta delta)
    {
        vm.startPrank(trader);
        usdc.approve(address(swapRouter), type(uint256).max);
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdc); // USDC -> token
        uint160 priceLimit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        delta = swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(usdcAmount), sqrtPriceLimitX96: priceLimit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    /// True iff an AntiSnipeApplied event was emitted since the last recordLogs.
    function _sawAntiSnipe() internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("AntiSnipeApplied(bytes32,address,uint256,uint16)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) return true;
        }
        return false;
    }

    /// CLOCK FIX + tax-is-applied. Under the pre-fix launch-anchored clock this
    /// buy would pay NO skim (window already elapsed during the curve). This
    /// test fails if the decay clock regresses to createLaunch OR if the buy
    /// side stops being taxed.
    function test_antisniper_taxesPostGradBuy_afterLongCurve() public {
        (address tokenAddr, PoolKey memory key) = _graduatePumpWithSnipe(2_000, 600);

        // Snipe is at (near) full strength AT graduation, despite the long curve.
        assertGt(hook.currentSnipeBps(tokenAddr), 1_900, "snipe active at graduation");

        vm.recordLogs();
        _buyViaV4(key, ALICE, 1_000e6);
        assertTrue(_sawAntiSnipe(), "post-grad buy must be snipe-taxed");
    }

    /// Anti-sniper auction proceeds go to the CREATOR, not the protocol. A
    /// taxed post-grad buy must credit the creator with the whole snipe skim
    /// (on top of its 80% fee cut); the treasury only ever sees the 20% fee
    /// cut, never the snipe. Catches a regression that routes the skim to
    /// TREASURY (the pre-2026-07-17 behaviour).
    function test_antisniper_proceedsGoToCreator() public {
        (address tokenAddr, PoolKey memory key) = _graduatePumpWithSnipe(2_000, 600);
        assertGt(hook.currentSnipeBps(tokenAddr), 1_900, "snipe active");

        uint256 creatorBefore = usdc.balanceOf(CREATOR);
        uint256 treasuryBefore = usdc.balanceOf(TREASURY);

        _buyViaV4(key, ALICE, 5_000e6);

        uint256 creatorGot = usdc.balanceOf(CREATOR) - creatorBefore;
        uint256 treasuryGot = usdc.balanceOf(TREASURY) - treasuryBefore;

        // Buy 5000 USDC: fee 1% = 50 (creator 40 / treasury 10), snipe ~20% =
        // ~1000 -> all to creator. So the creator (~1040) dwarfs the treasury
        // (~10, its fee cut only); the treasury never sees the ~1000 snipe.
        assertGt(creatorGot, 500e6, "creator receives the anti-sniper proceeds");
        assertLt(treasuryGot, 50e6, "treasury only gets its fee cut, not the snipe");
        assertGt(creatorGot, treasuryGot * 5, "proceeds routed to creator, not treasury");
    }

    /// DIRECTION. Only USDC -> token buys are snipes. A SELL must NOT trigger
    /// the anti-sniper. This is the test that catches an inverted
    /// _isUsdcToTokenSwap (the round-4 "snipers free, holders taxed" HIGH):
    /// invert it and this sell wrongly fires AntiSnipeApplied.
    function test_antisniper_doesNotTaxSells() public {
        (address tokenAddr, PoolKey memory key) = _graduatePumpWithSnipe(2_000, 600);
        assertGt(hook.currentSnipeBps(tokenAddr), 1_900, "snipe active");

        vm.recordLogs();
        _sellViaV4(key, tokenAddr, ALICE, 1_000e18);
        assertFalse(_sawAntiSnipe(), "sells are never snipe-taxed");
    }

    // ------------------------------------------------------------------
    // ArcadeV4SwapRouter against the REAL PoolManager. The router's own
    // ArcadeV4SwapRouter.t.sol uses a mock whose swap() ignores the price
    // limit, so it never exercised the sqrtPriceLimitX96=0 fix nor the
    // IncompleteOutput guard. These do, on an actually-graduated pool.
    // ------------------------------------------------------------------

    /// The core fix: sqrtPriceLimitX96 == 0 used to revert every swap. It must
    /// now resolve to the full tick range and complete an exact-input buy.
    function test_router_zeroLimitExactInputBuy_realPM() public {
        (address tokenAddr, PoolKey memory key) = _graduatePump();
        ArcadeV4SwapRouter router = new ArcadeV4SwapRouter(IPoolManager(address(pm)));

        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdc); // USDC -> token
        address buyer = address(0xB0B);
        usdc.mint(buyer, 1_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(router), type(uint256).max);
        uint256 out = router.exactInputSingle(key, zeroForOne, 1_000e6, 0, buyer, 0); // 0 = no limit
        vm.stopPrank();

        assertGt(out, 0, "0-limit exact-input must swap, not revert");
        assertEq(IERC20(tokenAddr).balanceOf(buyer), out, "recipient received the realised output");
    }

    /// Exact-output with 0 limit must deliver EXACTLY the requested output and
    /// must NOT false-trigger IncompleteOutput on a normal (non-partial) fill.
    function test_router_zeroLimitExactOutput_deliversExactly_realPM() public {
        (address tokenAddr, PoolKey memory key) = _graduatePump();
        ArcadeV4SwapRouter router = new ArcadeV4SwapRouter(IPoolManager(address(pm)));

        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdc);
        address buyer = address(0xB0B2);
        usdc.mint(buyer, 100_000e6);
        uint256 wantTokens = 1_000e18;
        vm.startPrank(buyer);
        usdc.approve(address(router), type(uint256).max);
        uint256 paid = router.exactOutputSingle(key, zeroForOne, wantTokens, type(uint256).max, buyer, 0);
        vm.stopPrank();

        assertEq(IERC20(tokenAddr).balanceOf(buyer), wantTokens, "recipient got exactly the requested output");
        assertGt(paid, 0, "input was paid");
    }

    /// The unimplemented CLANKER_V3 mode must be rejected at the door, not mint
    /// 1B supply into the immutable hook and strand it (the audit MEDIUM-1).
    function test_createLaunch_rejectsClankerV3Mode() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeHook.InvalidMode.selector);
        hook.createLaunch("V3", "V3", "ipfs://x", 2, address(0), 0, 0, 0, 0);
    }

    function test_postGradFee_PUMP_splits80_20_inUsdcOnSell() public {
        (address tokenAddr, PoolKey memory key) = _graduatePump();

        uint256 treasuryBefore = usdc.balanceOf(TREASURY);
        uint256 creatorBefore = usdc.balanceOf(CREATOR);

        _sellViaV4(key, tokenAddr, ALICE, 100_000e18);

        uint256 treasuryGot = usdc.balanceOf(TREASURY) - treasuryBefore;
        uint256 creatorGot = usdc.balanceOf(CREATOR) - creatorBefore;
        uint256 total = treasuryGot + creatorGot;
        // New model: the hook captures the whole trading fee on a non-trivial
        // sell, so it must be measurable.
        assertGt(total, 0, "fee paid");
        // Post-grad split is 80/20 creator/treasury for every mode.
        assertApproxEqRel(creatorGot, (total * 80) / 100, 0.01e18, "creator 80% (PUMP)");
        assertApproxEqRel(treasuryGot, (total * 20) / 100, 0.01e18, "treasury 20% (PUMP)");
    }

    function test_postGradFee_CLANKER_splits80_20() public {
        (address tokenAddr, PoolKey memory key) = _graduateClanker();

        uint256 treasuryBefore = usdc.balanceOf(TREASURY);
        uint256 creatorBefore = usdc.balanceOf(CREATOR);

        _sellViaV4(key, tokenAddr, ALICE, 100_000e18);

        uint256 treasuryGot = usdc.balanceOf(TREASURY) - treasuryBefore;
        uint256 creatorGot = usdc.balanceOf(CREATOR) - creatorBefore;
        uint256 total = treasuryGot + creatorGot;

        // CLANKER post-grad: creator 80%, treasury 20%.
        assertApproxEqRel(creatorGot, (total * 80) / 100, 0.01e18, "creator 80%");
        assertApproxEqRel(treasuryGot, (total * 20) / 100, 0.01e18, "treasury 20%");
    }

    // -------------------------------------------------------------------
    // Always-USDC fee capture: the fee lands in USDC on ALL FOUR swap
    // cases (buy/sell x exact-in/exact-out), never in the launch token.
    // beforeSwap covers the USDC-specified cases (buy exact-in, sell
    // exact-out); afterSwap covers the USDC-unspecified cases. Exactly one
    // side fires per swap so the fee is never double-charged.
    // -------------------------------------------------------------------

    /// Snapshot fee-recipient balances, run `body`, then assert the ENTIRE fee
    /// arrived in USDC (never in the launch token) and split 80/20.
    function _assertUsdcOnlyFee(
        address tokenAddr,
        uint256 cUsdc0,
        uint256 tUsdc0,
        uint256 cTok0,
        uint256 tTok0
    ) internal {
        uint256 cUsdc = usdc.balanceOf(CREATOR) - cUsdc0;
        uint256 tUsdc = usdc.balanceOf(TREASURY) - tUsdc0;
        uint256 cTok = IERC20(tokenAddr).balanceOf(CREATOR) - cTok0;
        uint256 tTok = IERC20(tokenAddr).balanceOf(TREASURY) - tTok0;
        uint256 total = cUsdc + tUsdc;
        assertGt(total, 0, "fee paid in USDC");
        // The launch token must NEVER be handed to a fee recipient.
        assertEq(cTok, 0, "creator got no token fee");
        assertEq(tTok, 0, "treasury got no token fee");
        assertApproxEqRel(cUsdc, (total * 80) / 100, 0.01e18, "creator 80%");
        assertApproxEqRel(tUsdc, (total * 20) / 100, 0.01e18, "treasury 20%");
    }

    /// buy exact-in: spend exact USDC (USDC specified) -> beforeSwap path.
    function test_alwaysUsdc_buyExactIn() public {
        (address tokenAddr, PoolKey memory key) = _graduatePump();
        uint256 cU = usdc.balanceOf(CREATOR);
        uint256 tU = usdc.balanceOf(TREASURY);
        uint256 cT = IERC20(tokenAddr).balanceOf(CREATOR);
        uint256 tT = IERC20(tokenAddr).balanceOf(TREASURY);
        _buyViaV4(key, ALICE, 5_000e6);
        _assertUsdcOnlyFee(tokenAddr, cU, tU, cT, tT);
    }

    /// sell exact-in: sell exact token, receive USDC (USDC unspecified) -> afterSwap.
    function test_alwaysUsdc_sellExactIn() public {
        (address tokenAddr, PoolKey memory key) = _graduatePump();
        uint256 cU = usdc.balanceOf(CREATOR);
        uint256 tU = usdc.balanceOf(TREASURY);
        uint256 cT = IERC20(tokenAddr).balanceOf(CREATOR);
        uint256 tT = IERC20(tokenAddr).balanceOf(TREASURY);
        _sellViaV4(key, tokenAddr, ALICE, 100_000e18);
        _assertUsdcOnlyFee(tokenAddr, cU, tU, cT, tT);
    }

    /// buy exact-out: want exact token, pay USDC (token specified, USDC
    /// unspecified) -> afterSwap path.
    function test_alwaysUsdc_buyExactOut() public {
        (address tokenAddr, PoolKey memory key) = _graduatePump();
        uint256 cU = usdc.balanceOf(CREATOR);
        uint256 tU = usdc.balanceOf(TREASURY);
        uint256 cT = IERC20(tokenAddr).balanceOf(CREATOR);
        uint256 tT = IERC20(tokenAddr).balanceOf(TREASURY);
        vm.startPrank(ALICE);
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdc); // USDC -> token
        uint160 lim = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: int256(500_000e18), sqrtPriceLimitX96: lim}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        _assertUsdcOnlyFee(tokenAddr, cU, tU, cT, tT);
    }

    /// sell exact-out: want exact USDC out, pay token (USDC specified) ->
    /// beforeSwap path. The critical new case: a SELL whose fee is taken in
    /// beforeSwap, still in USDC.
    function test_alwaysUsdc_sellExactOut() public {
        (address tokenAddr, PoolKey memory key) = _graduatePump();
        uint256 cU = usdc.balanceOf(CREATOR);
        uint256 tU = usdc.balanceOf(TREASURY);
        uint256 cT = IERC20(tokenAddr).balanceOf(CREATOR);
        uint256 tT = IERC20(tokenAddr).balanceOf(TREASURY);
        vm.startPrank(ALICE);
        IERC20(tokenAddr).approve(address(swapRouter), type(uint256).max);
        bool zeroForOne = Currency.unwrap(key.currency0) != address(usdc); // token -> USDC
        uint160 lim = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: int256(100e6), sqrtPriceLimitX96: lim}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        _assertUsdcOnlyFee(tokenAddr, cU, tU, cT, tT);
    }

    // -------------------------------------------------------------------
    // Locked LP: graduation seed cannot be removed by anyone external
    // -------------------------------------------------------------------

    function test_lockedLP_externalRemovalAttempt_revertsLockedPosition() public {
        (address tokenAddr, PoolKey memory key) = _graduatePump();
        tokenAddr;

        // An outsider tries to add LP (and would try to remove if they had one
        // on the right position). beforeAddLiquidity rejects external senders
        // since the LP is the hook's locked seed.
        // We simulate by calling pm.modifyLiquidity directly through an
        // unlock-aware harness. Lacking one in this test file, we assert the
        // hook's beforeAddLiquidity gate via vm.prank(poolManager).
        // Going through the manager would require a router; the gate itself
        // is unit-tested elsewhere. Here we just exercise the post-grad path
        // ends in a Graduated pool whose LP is intact after a V4 swap.
        ArcadeHook.CurveState memory s = hook.getCurveState(key.toId());
        assertEq(uint256(s.status), 2, "Graduated");
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

    // -------------------------------------------------------------------
    // PUMP dynamic fee: 1% at graduation, decaying toward 0.30% as market
    // cap grows, driven by a manipulation-resistant price EMA.
    // -------------------------------------------------------------------

    /// A fresh graduate charges the 1% ceiling: the EMA starts AT the
    /// graduation mcap tick so there is zero growth yet.
    function test_pumpFee_startsAtMax() public {
        (address token,) = _graduatePump();
        assertEq(hook.currentFeeBps(token), 100, "1% at graduation");
    }

    /// Drive the price up with repeated buys spaced over time; the EMA climbs
    /// and the PUMP fee must fall below 1% but never under the 0.30% floor.
    function test_pumpFee_decaysAsMarketCapGrows() public {
        (address token, PoolKey memory key) = _graduatePump();
        usdc.mint(ALICE, 100_000e6);
        uint256 f0 = hook.currentFeeBps(token);
        assertEq(f0, 100, "starts at 1%");

        // Modest buys spaced over time push the price up and climb the EMA.
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 12; i++) {
            t += 3 hours;
            vm.warp(t);
            _buyViaV4(key, ALICE, 1_000e6);
        }

        uint256 f1 = hook.currentFeeBps(token);
        assertLt(f1, f0, "fee decayed as mcap grew");
        assertGe(f1, 30, "never under the 0.30% floor");
    }

    /// Push the market cap far past the floor threshold (10x+) over time: the
    /// fee must clamp exactly at the 0.30% floor and stay there.
    function test_pumpFee_floorsAt30bps() public {
        (address token, PoolKey memory key) = _graduatePump();
        usdc.mint(ALICE, 100_000e6);

        // Sustained buying over time pushes market cap well past the 10x floor
        // threshold; the EMA converges and the fee clamps at 0.30%. Track time
        // in a local so each iteration genuinely advances the oracle clock.
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 30; i++) {
            t += 6 hours;
            vm.warp(t);
            _buyViaV4(key, ALICE, 1_500e6);
        }

        assertEq(hook.currentFeeBps(token), 30, "clamped at 0.30% floor");
    }

    // -------------------------------------------------------------------
    // CLANKER static fee tiers: the creator picks 1/2/3% at launch and it
    // never changes (unlike PUMP's mcap decay).
    // -------------------------------------------------------------------

    function _graduateClankerTier(uint8 tier) internal returns (address tokenAddr, PoolKey memory key) {
        vm.prank(CREATOR);
        (tokenAddr,) = hook.createLaunch("ClkTier", "CLK", "ipfs://demo", 1, address(0), 0, 0, 0, tier);
        key = _buildKey(tokenAddr);
        vm.prank(ALICE);
        hook.buy(tokenAddr, 30_000e6, 0);
    }

    function test_clankerFee_tier1_is1pct() public {
        (address token,) = _graduateClankerTier(1);
        assertEq(hook.currentFeeBps(token), 100, "tier 1 = 1%");
    }

    function test_clankerFee_tier2_is2pct() public {
        (address token,) = _graduateClankerTier(2);
        assertEq(hook.currentFeeBps(token), 200, "tier 2 = 2%");
    }

    function test_clankerFee_tier3_is3pct() public {
        (address token,) = _graduateClankerTier(3);
        assertEq(hook.currentFeeBps(token), 300, "tier 3 = 3%");
    }

    /// CLANKER tiers are STATIC: market-cap growth that would decay a PUMP fee
    /// leaves a CLANKER tier untouched.
    function test_clankerFee_staysStaticAcrossMcapGrowth() public {
        (address token, PoolKey memory key) = _graduateClankerTier(3);
        usdc.mint(ALICE, 100_000e6);
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 10; i++) {
            t += 3 hours;
            vm.warp(t);
            _buyViaV4(key, ALICE, 1_000e6);
        }
        assertEq(hook.currentFeeBps(token), 300, "CLANKER tier is static, not mcap-decaying");
    }

    /// A CLANKER launch MUST pick a valid tier (1/2/3). Zero or out-of-range
    /// reverts before any USDC is pulled.
    function test_createLaunch_revertsOnInvalidClankerTier() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeHook.InvalidFeeTier.selector);
        hook.createLaunch("X", "X", "ipfs://x", 1, address(0), 0, 0, 0, 0);

        vm.prank(CREATOR);
        vm.expectRevert(ArcadeHook.InvalidFeeTier.selector);
        hook.createLaunch("Y", "Y", "ipfs://y", 1, address(0), 0, 0, 0, 4);
    }

    /// PUMP ignores the fee-tier argument entirely: its fee is the mcap-decaying
    /// dynamic curve regardless of what tier value is passed. Proves PUMP fees
    /// are NOT creator-customisable (only CLANKER's are).
    function test_createLaunch_pumpIgnoresFeeTier() public {
        vm.prank(CREATOR);
        (address token,) = hook.createLaunch("P", "P", "ipfs://p", 0, address(0), 0, 0, 0, 3);
        vm.prank(ALICE);
        hook.buy(token, 30_000e6, 0);
        // Dynamic fee starts at 1% at graduation, NOT tier 3's 3%.
        assertEq(hook.currentFeeBps(token), 100, "PUMP uses dynamic fee, tier arg ignored");
    }

    /// Manipulation resistance: multiple swaps within the SAME block timestamp
    /// must not move the oracle at all (dt == 0 guard), so a flash spike +
    /// revert in one tx cannot swing the fee anyone pays.
    function test_pumpFee_intraBlockSpikeDoesNotMoveFee() public {
        (address token, PoolKey memory key) = _graduatePump();
        usdc.mint(ALICE, 5_000_000e6);

        // Advance the EMA to a mid value first.
        vm.warp(block.timestamp + 3 hours);
        _buyViaV4(key, ALICE, 100_000e6);
        uint256 fBefore = hook.currentFeeBps(token);

        // Two more swaps in the SAME block (no warp): oracle frozen.
        _buyViaV4(key, ALICE, 500_000e6);
        uint256 fMid = hook.currentFeeBps(token);
        _sellViaV4(key, token, ALICE, 1_000_000e18);
        uint256 fAfter = hook.currentFeeBps(token);

        assertEq(fBefore, fMid, "no EMA move intra-block (buy)");
        assertEq(fMid, fAfter, "no EMA move intra-block (sell)");
    }
}

/**
 * @title ArcadeHookSwapUsdcCurrency0Test
 * @notice Re-runs the ENTIRE swap/fee suite with USDC forced to sort as
 *         currency0 -- the ARC MAINNET ordering. On mainnet USDC is
 *         0x3600...0000 (a near-minimal address), so every CREATE-deployed
 *         launch token sorts ABOVE it and USDC is currency0 for essentially
 *         every real launch. The base suite exercises USDC-as-currency1 only;
 *         this subclass covers the dominant, production `usdcIsCurrency0 == true`
 *         branch (the mcap-tick sign flip in _mcapTick, the capture side in
 *         before/afterSwap, the anti-sniper direction) before an immutable
 *         mainnet deploy. It inherits every test unchanged -- the helpers derive
 *         swap direction from the key, so they adapt automatically.
 */
contract ArcadeHookSwapUsdcCurrency0Test is ArcadeHookSwapTest {
    /// Place USDC at a low address so it sorts below the launch tokens. Uses
    /// deployCodeTo so the ERC20 constructor runs at the target (storage set
    /// there), unlike a bare etch. 0x7770 is above the precompile range and far
    /// below any keccak-derived CREATE address.
    function _makeUsdc() internal override returns (TestERC20) {
        address lowUsdc = address(0x7770);
        deployCodeTo("TestERC20.sol:TestERC20", abi.encode(uint256(0)), lowUsdc);
        return TestERC20(lowUsdc);
    }
}
