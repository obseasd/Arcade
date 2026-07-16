// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {ArcadeMigratedRouter} from "../src/swap/ArcadeMigratedRouter.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeMultiSwap, IArcadeV4SwapRouterMin, IArcadeV4LaunchpadMin} from "../src/swap/ArcadeMultiSwap.sol";
import {IArcadeV3Factory, IArcadeV3Router} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Tests for ArcadeMultiSwap. To work around `via_ir` stack-too-deep
/// when memory struct arrays bounce through too many helper frames, all
/// `Input[]` arrays live in storage rather than memory.
contract ArcadeMultiSwapTest is Test {
    MockUSDC usdc;
    ArcadeV2Factory factory;
    ArcadeV2Router router;
    ArcadeLaunchpad launchpad;
    ArcadeMigratedRouter migratedRouter;
    ArcadeMultiSwap multiSwap;

    address treasury = address(0xBEEF);
    address creatorA = address(0xA0A0);
    address creatorB = address(0xB0B0);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    address tokenA;
    address tokenB;

    /// Reusable storage scratch space — built up by `_pushInput` per test.
    ArcadeMultiSwap.Input[] inputsBuf;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new ArcadeV2Factory(address(this));
        // Graduated pairs pay 0.15% to factory.feeTo; unset it and the protocol
        // leg silently pays 0 (fails toward the pool, by design).
        factory.setFeeTo(treasury);
        router = new ArcadeV2Router(address(factory));
        launchpad = new ArcadeLaunchpad(
            IERC20(address(usdc)), factory, address(router), treasury, IArcadeV3Factory(address(0)), address(0)
        );
        factory.setLaunchpad(address(launchpad));
        migratedRouter = new ArcadeMigratedRouter(IERC20(address(usdc)), address(router), IArcadeLaunchpad(address(launchpad)));
        multiSwap = new ArcadeMultiSwap(
            IERC20(address(usdc)),
            factory,
            router,
            IArcadeLaunchpad(address(launchpad)),
            // V3 + V4 are unused in these tests (no Clanker V3 or V4 launches).
            IArcadeV3Router(address(0)),
            IArcadeV4SwapRouterMin(address(0)),
            IArcadeV4LaunchpadMin(address(0))
        );
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        tokenA = _createTokenAs(creatorA, "Alpha", "A");
        tokenB = _createTokenAs(creatorB, "Bravo", "B");
        _migrate(tokenA);
        _migrate(tokenB);
    }

    function _resetInputs() internal {
        delete inputsBuf;
    }

    function _pushInput(address t, uint256 a) internal {
        // Default: no per-leg floor (minOut/usdcMidMin = 0). The basket-wide
        // minTotalOut passed to swapToSingle still gates the whole call.
        inputsBuf.push(ArcadeMultiSwap.Input({token: t, amount: a, minOut: 0, usdcMidMin: 0}));
    }

    function _pushInputWithMin(address t, uint256 a, uint256 minOut, uint256 usdcMidMin) internal {
        inputsBuf.push(ArcadeMultiSwap.Input({token: t, amount: a, minOut: minOut, usdcMidMin: usdcMidMin}));
    }

    function _createTokenAs(address as_, string memory n, string memory s) internal returns (address) {
        usdc.mint(as_, launchpad.CREATION_FEE());
        vm.startPrank(as_);
        usdc.approve(address(launchpad), type(uint256).max);
        address t = launchpad.createToken(n, s, "ipfs://x", IArcadeLaunchpad.LaunchMode.PUMP, address(0), 0);
        vm.stopPrank();
        return t;
    }

    function _migrate(address token) internal {
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000e6, 0);
        vm.stopPrank();
    }

    function _bobBuysMigrated(address token, uint256 usdcIn) internal returns (uint256) {
        vm.startPrank(bob);
        usdc.approve(address(migratedRouter), type(uint256).max);
        uint256 amount = migratedRouter.buyMigrated(token, usdcIn, 0, block.timestamp + 600);
        vm.stopPrank();
        return amount;
    }

    function test_swapToSingle_USDC_input_directRoute() public {
        _resetInputs();
        _pushInput(address(usdc), 100e6);
        vm.startPrank(bob);
        usdc.approve(address(multiSwap), type(uint256).max);
        uint256 totalOut = multiSwap.swapToSingle(inputsBuf, tokenA, 0, block.timestamp + 60);
        vm.stopPrank();
        assertGt(totalOut, 0, "got tokens");
        assertEq(IERC20(tokenA).balanceOf(bob), totalOut, "balance matches return");
    }

    // HIGH-1 (2026-07-02 fee audit): selling migrated tokens to USDC through
    // MultiSwap MUST charge the post-migration royalty. The old routing hit a
    // plain V2 swap first (because `oneSideUsdc` is true), bypassing the
    // royalty entirely -- this test previously asserted "noRoyalty" and locked
    // in the bug. It now asserts the royalty is paid via sellMigrated.
    function test_swapToSingle_twoMigratedInputs_toUsdc_chargesRoyalty() public {
        uint256 boughtA = _bobBuysMigrated(tokenA, 500e6);
        uint256 boughtB = _bobBuysMigrated(tokenB, 500e6);

        uint256 t0 = usdc.balanceOf(treasury);
        uint256 ca0 = usdc.balanceOf(creatorA);
        uint256 cb0 = usdc.balanceOf(creatorB);

        _resetInputs();
        _pushInput(tokenA, boughtA);
        _pushInput(tokenB, boughtB);

        vm.startPrank(bob);
        IERC20(tokenA).approve(address(multiSwap), type(uint256).max);
        IERC20(tokenB).approve(address(multiSwap), type(uint256).max);
        uint256 totalOut = multiSwap.swapToSingle(inputsBuf, address(usdc), 0, block.timestamp + 60);
        vm.stopPrank();

        assertGt(totalOut, 0);
        // The pair charges the fee on the INPUT. Both legs SELL a migrated
        // token, so both fees are denominated in those TOKENS, not USDC.
        // (Input-side is what keeps `to` receiving exactly amountOut, which
        // keeps UniswapV2Library bit-exact and amountOutMin honest.)
        assertEq(usdc.balanceOf(treasury), t0, "no USDC fee: both legs are sells");
        assertEq(usdc.balanceOf(creatorA), ca0, "no USDC fee: leg is a sell");
        assertEq(usdc.balanceOf(creatorB), cb0, "no USDC fee: leg is a sell");
        assertGt(IERC20(tokenA).balanceOf(creatorA), 0, "creatorA paid in tokenA");
        assertGt(IERC20(tokenB).balanceOf(creatorB), 0, "creatorB paid in tokenB");
        assertGt(IERC20(tokenA).balanceOf(treasury), 0, "protocol paid in tokenA");
    }

    // HIGH-1: buying a migrated token with USDC through MultiSwap must also
    // charge the royalty (buyMigrated path), not the old royalty-free V2 buy.
    function test_swapToSingle_usdcToMigrated_chargesRoyalty() public {
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 ca0 = usdc.balanceOf(creatorA);

        _resetInputs();
        _pushInput(address(usdc), 500e6);

        vm.startPrank(bob);
        usdc.approve(address(multiSwap), type(uint256).max);
        uint256 totalOut = multiSwap.swapToSingle(inputsBuf, tokenA, 0, block.timestamp + 60);
        vm.stopPrank();

        assertGt(totalOut, 0, "got tokens");
        assertEq(IERC20(tokenA).balanceOf(bob), totalOut, "balance matches return");
        // Royalty skimmed from the USDC input and split platform / creator.
        assertGt(usdc.balanceOf(treasury), t0, "treasury paid royalty");
        assertGt(usdc.balanceOf(creatorA), ca0, "creatorA paid royalty");
    }

    function test_swapToSingle_migratedToMigrated_multihop_chargesRoyalty() public {
        uint256 boughtA = _bobBuysMigrated(tokenA, 500e6);

        uint256 t0 = usdc.balanceOf(treasury);
        uint256 ca0 = usdc.balanceOf(creatorA);
        uint256 cb0 = usdc.balanceOf(creatorB);

        _resetInputs();
        _pushInput(tokenA, boughtA);

        (uint256 quoted,) = multiSwap.quoteSwapToSingle(inputsBuf, tokenB);

        vm.startPrank(bob);
        IERC20(tokenA).approve(address(multiSwap), type(uint256).max);
        uint256 totalOut = multiSwap.swapToSingle(inputsBuf, tokenB, 0, block.timestamp + 60);
        vm.stopPrank();

        assertEq(totalOut, quoted, "delivered == quoted");
        // tokenA -> USDC -> tokenB. Leg 1 SELLS tokenA, so its fee is in
        // tokenA. Leg 2 BUYS tokenB with USDC, so its fee is in USDC. The fee
        // always lands in whatever token came IN.
        assertEq(usdc.balanceOf(creatorA), ca0, "creatorA's leg is a sell: paid in tokenA");
        assertGt(IERC20(tokenA).balanceOf(creatorA), 0, "creatorA paid in tokenA");
        assertGt(usdc.balanceOf(creatorB), cb0, "creatorB's leg is a buy: paid in USDC");
        assertGt(usdc.balanceOf(treasury), t0, "treasury paid in USDC on the buy leg");
    }

    /// F-1: MultiSwap path 4's mid-leg floor had NO test. After the migrated
    /// wrappers moved to ArcadeMigratedRouter, migrated token<->token flows
    /// through MultiSwap path 4 (_swapV2 viaUsdc), whose midFloor = the caller's
    /// usdcMidMin. This is the ONLY thing stopping a sandwicher who moves just
    /// the tokenIn/USDC pool from driving usdcMid low and scraping past minOut.
    /// A floor above the achievable mid MUST revert; deleting the midFloor
    /// enforcement would leave every OTHER test green. Mirror of the router-side
    /// guard test.
    function test_swapToSingle_migratedMidLegFloor_revertsWhenUnreachable() public {
        uint256 boughtA = _bobBuysMigrated(tokenA, 500e6);

        _resetInputs();
        // A floor far above any achievable mid (selling boughtA yields well
        // under the 500e6 that bought them, after fee + price impact).
        _pushInputWithMin(tokenA, boughtA, 0, 500e6);

        vm.startPrank(bob);
        IERC20(tokenA).approve(address(multiSwap), type(uint256).max);
        vm.expectRevert(); // leg-1 V2 swap reverts: mid < midFloor
        multiSwap.swapToSingle(inputsBuf, tokenB, 0, block.timestamp + 60);
        vm.stopPrank();

        // And a realistic floor (below the achievable mid) clears.
        _resetInputs();
        _pushInputWithMin(tokenA, boughtA, 0, 1);
        vm.startPrank(bob);
        uint256 out = multiSwap.swapToSingle(inputsBuf, tokenB, 0, block.timestamp + 60);
        vm.stopPrank();
        assertGt(out, 0, "a reachable floor clears");
    }

    function test_swapToSingle_sameInOut_passthrough() public {
        _resetInputs();
        _pushInput(address(usdc), 50e6);

        uint256 before = usdc.balanceOf(bob);
        vm.startPrank(bob);
        usdc.approve(address(multiSwap), type(uint256).max);
        uint256 totalOut = multiSwap.swapToSingle(inputsBuf, address(usdc), 50e6, block.timestamp + 60);
        vm.stopPrank();
        assertEq(totalOut, 50e6, "passthrough preserves amount");
        assertEq(usdc.balanceOf(bob), before, "balance unchanged net");
    }

    function test_swapToSingle_minOutEnforced() public {
        _resetInputs();
        _pushInput(address(usdc), 10e6);
        vm.startPrank(bob);
        usdc.approve(address(multiSwap), type(uint256).max);
        vm.expectRevert(ArcadeMultiSwap.InsufficientOutput.selector);
        multiSwap.swapToSingle(inputsBuf, tokenA, type(uint256).max, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_swapToSingle_deadlineEnforced() public {
        _resetInputs();
        _pushInput(address(usdc), 10e6);
        vm.startPrank(bob);
        usdc.approve(address(multiSwap), type(uint256).max);
        vm.expectRevert(ArcadeMultiSwap.DeadlinePassed.selector);
        multiSwap.swapToSingle(inputsBuf, tokenA, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_swapToSingle_emptyInputs_reverts() public {
        _resetInputs();
        vm.expectRevert(ArcadeMultiSwap.EmptyInputs.selector);
        multiSwap.swapToSingle(inputsBuf, tokenA, 0, block.timestamp + 60);
    }

    /// H-07: a single thin leg whose per-leg `minOut` is violated must revert
    /// the WHOLE basket, even when the OTHER leg's output would keep the
    /// basket total above the aggregate `minTotalOut`. This is the exact
    /// sandwich hole H-07 closes: pre-fix, leg slippage was unprotected (the
    /// router got amountOutMinimum=0) so an attacker could fully drain the
    /// thin leg as long as the fat leg carried the basket.
    function test_swapToSingle_thinLeg_perLegMinOutEnforced() public {
        // Two USDC inputs converging to tokenA. Both legs route USDC->tokenA
        // (direct V2). Leg 0 is small ("thin"), leg 1 is large ("fat").
        _resetInputs();
        // Leg 0: 1 USDC in, but demand an impossibly high per-leg minOut so
        // the leg's own floor is violated regardless of the basket total.
        _pushInputWithMin(address(usdc), 1e6, type(uint256).max, 0);
        // Leg 1: 1000 USDC in, no per-leg floor. On its own this leg's output
        // would dwarf any reasonable basket minTotalOut.
        _pushInput(address(usdc), 1_000e6);

        vm.startPrank(bob);
        usdc.approve(address(multiSwap), type(uint256).max);
        // Basket minTotalOut = 0 so the ONLY thing that can revert is the
        // per-leg floor on leg 0. Pre-H-07 this call succeeded (leg slippage
        // was unprotected); post-fix it must revert. The floor is threaded
        // straight into the V2 router's `amountOutMinimum`, so the router's
        // own `InsufficientOutputAmount` guard fires first (before the
        // aggregator's belt-and-suspenders `InsufficientOutput` check). We
        // accept ANY revert here since either guard proves the leg is now
        // protected.
        vm.expectRevert();
        multiSwap.swapToSingle(inputsBuf, tokenA, 0, block.timestamp + 60);
        vm.stopPrank();
    }

    /// Companion happy-path: the SAME basket with a realistic per-leg floor
    /// (derived from the quote) succeeds, proving the floor only bites on a
    /// genuine shortfall.
    function test_swapToSingle_perLegMinOut_passesWhenQuoteMet() public {
        _resetInputs();
        _pushInput(address(usdc), 1e6);
        _pushInput(address(usdc), 1_000e6);
        (, uint256[] memory per) = multiSwap.quoteSwapToSingle(inputsBuf, tokenA);

        _resetInputs();
        // Floor each leg at 99% of its own quote.
        _pushInputWithMin(address(usdc), 1e6, (per[0] * 99) / 100, 0);
        _pushInputWithMin(address(usdc), 1_000e6, (per[1] * 99) / 100, 0);

        vm.startPrank(bob);
        usdc.approve(address(multiSwap), type(uint256).max);
        uint256 totalOut = multiSwap.swapToSingle(inputsBuf, tokenA, 0, block.timestamp + 60);
        vm.stopPrank();
        assertGt(totalOut, 0, "swap succeeded with per-leg floors met");
    }

    function test_quoteSwapToSingle_handlesMixedInputs() public {
        uint256 boughtA = _bobBuysMigrated(tokenA, 250e6);
        _resetInputs();
        _pushInput(tokenA, boughtA);
        _pushInput(address(usdc), 100e6);
        (uint256 totalOut, uint256[] memory per) = multiSwap.quoteSwapToSingle(inputsBuf, address(usdc));
        assertEq(per[1], 100e6, "USDC passthrough");
        assertGt(per[0], 0, "tokenA quote nonzero");
        assertEq(totalOut, per[0] + per[1]);
    }
}
