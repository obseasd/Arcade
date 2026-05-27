// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeMultiSwap} from "../src/swap/ArcadeMultiSwap.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Tests for ArcadeMultiSwap. To work around `via_ir` stack-too-deep
/// when memory struct arrays bounce through too many helper frames, all
/// `Input[]` arrays live in storage rather than memory.
contract ArcadeMultiSwapTest is Test {
    MockUSDC usdc;
    ArcadeV2Factory factory;
    ArcadeV2Router router;
    ArcadeLaunchpad launchpad;
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
        router = new ArcadeV2Router(address(factory));
        launchpad = new ArcadeLaunchpad(IERC20(address(usdc)), factory, address(router), treasury);
        multiSwap =
            new ArcadeMultiSwap(IERC20(address(usdc)), factory, router, IArcadeLaunchpad(address(launchpad)));
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
        inputsBuf.push(ArcadeMultiSwap.Input({token: t, amount: a}));
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
        usdc.approve(address(launchpad), type(uint256).max);
        uint256 amount = launchpad.buyMigrated(token, usdcIn, 0);
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

    function test_swapToSingle_twoMigratedInputs_toUsdc_noRoyalty() public {
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
        // Each leg is a direct V2 swap (tokenX <-> USDC pair exists), so the
        // launchpad's royalty path is NOT triggered.
        assertEq(usdc.balanceOf(treasury), t0, "treasury unchanged");
        assertEq(usdc.balanceOf(creatorA), ca0, "creatorA unchanged");
        assertEq(usdc.balanceOf(creatorB), cb0, "creatorB unchanged");
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
        assertGt(usdc.balanceOf(creatorA), ca0, "creatorA paid");
        assertGt(usdc.balanceOf(creatorB), cb0, "creatorB paid");
        assertGt(usdc.balanceOf(treasury), t0, "treasury paid");
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
