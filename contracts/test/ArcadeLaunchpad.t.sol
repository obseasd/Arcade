// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeV2Pair} from "../src/dex/ArcadeV2Pair.sol";
import {IArcadeV2Pair} from "../src/dex/interfaces/IArcadeV2Pair.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeLaunchToken} from "../src/launchpad/ArcadeLaunchToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ArcadeLaunchpadTest is Test {
    MockUSDC usdc;
    ArcadeV2Factory factory;
    ArcadeV2Router router;
    ArcadeLaunchpad launchpad;

    address treasury = address(0xBEEF);
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        usdc = new MockUSDC();
        factory = new ArcadeV2Factory(address(this));
        router = new ArcadeV2Router(address(factory));
        launchpad = new ArcadeLaunchpad(IERC20(address(usdc)), factory, treasury);

        // Fund users
        usdc.mint(creator, 100 * 10 ** 6);
        usdc.mint(alice, 200_000 * 10 ** 6);
        usdc.mint(bob, 50_000 * 10 ** 6);
    }

    function _createToken() internal returns (address) {
        return _createTokenMode(IArcadeLaunchpad.LaunchMode.PUMP, address(0), 0);
    }

    function _createTokenMode(IArcadeLaunchpad.LaunchMode mode, address creator2, uint16 share)
        internal
        returns (address)
    {
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        address tokenAddr = launchpad.createToken("MoonCat", "MCAT", "ipfs://test", mode, creator2, share);
        vm.stopPrank();
        return tokenAddr;
    }

    function test_createToken_chargesCreationFee() public {
        uint256 before = usdc.balanceOf(treasury);
        address token = _createToken();
        assertEq(usdc.balanceOf(treasury), before + launchpad.CREATION_FEE());
        assertEq(IERC20(token).balanceOf(address(launchpad)), launchpad.TOTAL_SUPPLY());
    }

    function test_buy_smallAmount_distributesFees() public {
        address token = _createToken();
        uint256 amountIn = 100 * 10 ** 6; // 100 USDC

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 creatorBefore = usdc.balanceOf(creator);

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        (uint256 tokensOut,,) = launchpad.buy(token, amountIn, 0);
        vm.stopPrank();

        // Fee = 1% of 100 = 1 USDC, split 50/50
        uint256 expectedPlatformFee = (amountIn * 50) / 10_000;
        uint256 expectedCreatorFee = (amountIn * 50) / 10_000;
        assertEq(usdc.balanceOf(treasury), treasuryBefore + expectedPlatformFee, "platform fee");
        assertEq(usdc.balanceOf(creator), creatorBefore + expectedCreatorFee, "creator fee");
        assertEq(IERC20(token).balanceOf(alice), tokensOut, "tokens to buyer");
        assertGt(tokensOut, 0, "got some tokens");
    }

    function test_buy_then_sell_reduces_position() public {
        address token = _createToken();

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        (uint256 tokensOut,,) = launchpad.buy(token, 1_000 * 10 ** 6, 0);

        IERC20(token).approve(address(launchpad), type(uint256).max);
        uint256 usdcOut = launchpad.sell(token, tokensOut / 2, 0);
        vm.stopPrank();

        assertGt(usdcOut, 0);
        assertEq(IERC20(token).balanceOf(alice), tokensOut - tokensOut / 2);
    }

    function test_buy_largeAmount_triggersMigration() public {
        address token = _createToken();

        // Buy enough to overshoot — should be capped and trigger migration
        uint256 hugeAmount = 100_000 * 10 ** 6; // 100k USDC, way over the 20k target

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        (uint256 tokensOut, uint256 usdcSpent, uint256 refund) = launchpad.buy(token, hugeAmount, 0);
        vm.stopPrank();

        // State checks
        ArcadeLaunchpad.TokenState memory state = launchpad.getTokenState(token);
        assertTrue(state.migrated, "should be migrated");
        assertGt(state.migratedAt, 0);
        assertTrue(state.v2Pair != address(0), "v2 pair created");

        // Alice should have received exactly the curve supply (no more, no less)
        assertEq(tokensOut, launchpad.CURVE_SUPPLY(), "got entire curve supply");
        // Refund should be substantial
        assertGt(refund, 0, "refund overshoot");
        // usdcSpent should be < hugeAmount
        assertLt(usdcSpent, hugeAmount);

        // The V2 pair should hold the migration LP tokens + the collected USDC (minus fees)
        uint256 pairUsdc = usdc.balanceOf(state.v2Pair);
        uint256 pairTokens = IERC20(token).balanceOf(state.v2Pair);
        assertEq(pairTokens, launchpad.MIGRATION_LP_TOKENS(), "200M tokens in pair");
        assertGt(pairUsdc, 0, "USDC in pair");

        // LP tokens locked to dead address
        uint256 deadLp = IERC20(state.v2Pair).balanceOf(launchpad.DEAD());
        assertGt(deadLp, 0, "LP burned");
    }

    function test_postMigration_swapWorksViaRouter() public {
        address token = _createToken();

        // Trigger migration
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0);
        vm.stopPrank();

        // Bob swaps on the V2 router
        vm.startPrank(bob);
        usdc.approve(address(router), type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = token;
        uint256 amountIn = 50 * 10 ** 6;
        uint256[] memory amountsOut = router.getAmountsOut(amountIn, path);
        router.swapExactTokensForTokens(amountIn, amountsOut[1] * 99 / 100, path, bob, block.timestamp + 60);
        vm.stopPrank();

        assertGt(IERC20(token).balanceOf(bob), 0, "bob got tokens via DEX");
    }

    function test_buy_revertsAfterMigration() public {
        address token = _createToken();
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0);

        vm.expectRevert(ArcadeLaunchpad.AlreadyMigrated.selector);
        launchpad.buy(token, 10 * 10 ** 6, 0);
        vm.stopPrank();
    }

    function test_quoteBuy_matchesActualBuy() public {
        address token = _createToken();
        uint256 amountIn = 500 * 10 ** 6;

        (uint256 quoted,) = launchpad.quoteBuy(token, amountIn);

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        (uint256 actual,,) = launchpad.buy(token, amountIn, 0);
        vm.stopPrank();

        assertEq(quoted, actual, "quote == actual");
    }

    function test_clankerMode_splitsFees70_30_acrossTwoCreators() public {
        address creator2 = address(0xCAFE);

        // 50/50 split of the creator portion between creator and creator2
        address token = _createTokenMode(IArcadeLaunchpad.LaunchMode.CLANKER, creator2, 5_000);

        // Snapshot balances AFTER the creation fee has been paid, so we only
        // measure the trade-fee distribution that follows.
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 c1_0 = usdc.balanceOf(creator);
        uint256 c2_0 = usdc.balanceOf(creator2);

        uint256 amountIn = 1_000 * 10 ** 6; // 1,000 USDC
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, amountIn, 0);
        vm.stopPrank();

        uint256 totalFee = (amountIn * 100) / 10_000; // 1% of 1000 = 10 USDC
        uint256 expectedPlatform = (totalFee * 7_000) / 10_000; // 70% = 7
        uint256 expectedCreatorPortion = totalFee - expectedPlatform; // 3
        uint256 expectedCreator2 = (expectedCreatorPortion * 5_000) / 10_000; // 1.5
        uint256 expectedCreator1 = expectedCreatorPortion - expectedCreator2; // 1.5

        assertEq(usdc.balanceOf(treasury), t0 + expectedPlatform, "treasury: 70% platform");
        assertEq(usdc.balanceOf(creator), c1_0 + expectedCreator1, "creator1: 15% of trade");
        assertEq(usdc.balanceOf(creator2), c2_0 + expectedCreator2, "creator2: 15% of trade");
    }

    function test_postComment_emitsAndStores() public {
        address token = _createToken();
        vm.prank(alice);
        launchpad.postComment(token, "first!");
        assertEq(launchpad.getCommentsCount(token), 1);
        ArcadeLaunchpad.Comment[] memory comments = launchpad.getComments(token, 0, 10);
        assertEq(comments.length, 1);
        assertEq(comments[0].author, alice);
        assertEq(comments[0].text, "first!");
    }

    function test_marketCap_increasesWithBuys() public {
        address token = _createToken();
        uint256 mcap0 = launchpad.marketCap(token);

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 1_000 * 10 ** 6, 0);
        vm.stopPrank();

        uint256 mcap1 = launchpad.marketCap(token);
        assertGt(mcap1, mcap0, "mcap should grow");
    }
}
