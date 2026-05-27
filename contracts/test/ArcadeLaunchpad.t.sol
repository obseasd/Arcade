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
        launchpad = new ArcadeLaunchpad(IERC20(address(usdc)), factory, address(router), treasury);

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

    function test_buyMigrated_takesRoyaltyAndDelivers() public {
        address creator2 = address(0xCAFE);
        address token = _createTokenMode(IArcadeLaunchpad.LaunchMode.CLANKER, creator2, 5_000);

        // Migrate the curve by overshooting
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0);
        vm.stopPrank();

        // Snapshot fee receivers AFTER migration
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 c1_0 = usdc.balanceOf(creator);
        uint256 c2_0 = usdc.balanceOf(creator2);

        // Bob buys 100 USDC of the migrated token via the launchpad's wrapper
        uint256 amountIn = 100 * 10 ** 6;
        vm.startPrank(bob);
        usdc.approve(address(launchpad), type(uint256).max);
        uint256 tokensOut = launchpad.buyMigrated(token, amountIn, 0);
        vm.stopPrank();

        assertGt(tokensOut, 0, "tokens received");

        // Post-migration royalty = 0.30% on 100 USDC = 0.30 USDC.
        // Uniform 0.20% platform / 0.10% creator split (mode-independent).
        // For CLANKER with creator2 at 50/50: creator1 = 0.05%, creator2 = 0.05%.
        uint256 expectedPlatform = (amountIn * 20) / 10_000; // 0.20 USDC
        uint256 expectedCreatorPortion = (amountIn * 10) / 10_000; // 0.10 USDC
        uint256 expectedCreator2 = expectedCreatorPortion / 2;
        uint256 expectedCreator1 = expectedCreatorPortion - expectedCreator2;
        assertEq(usdc.balanceOf(treasury), t0 + expectedPlatform, "treasury royalty");
        assertEq(usdc.balanceOf(creator), c1_0 + expectedCreator1, "creator1 royalty");
        assertEq(usdc.balanceOf(creator2), c2_0 + expectedCreator2, "creator2 royalty");
    }

    function test_sellMigrated_takesRoyaltyOnOutput() public {
        address token = _createToken(); // PUMP mode, single creator

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0); // migrate
        vm.stopPrank();

        // Bob buys some via the migrated wrapper to acquire tokens
        vm.startPrank(bob);
        usdc.approve(address(launchpad), type(uint256).max);
        uint256 bought = launchpad.buyMigrated(token, 500 * 10 ** 6, 0);

        uint256 t0 = usdc.balanceOf(treasury);
        uint256 c0 = usdc.balanceOf(creator);

        IERC20(token).approve(address(launchpad), type(uint256).max);
        uint256 received = launchpad.sellMigrated(token, bought, 0);
        vm.stopPrank();

        // Sell pays USDC out, with 0.30% royalty skimmed first; PUMP = 50/50
        assertGt(received, 0, "received USDC");
        assertGt(usdc.balanceOf(treasury), t0, "treasury got fees");
        assertGt(usdc.balanceOf(creator), c0, "creator got fees");
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

    /// @notice Helper to create a token with a custom creator (sender). Used
    /// when a test needs multiple tokens from different creators so we can
    /// attribute royalty payouts to the right address.
    function _createTokenAs(
        address asCreator,
        IArcadeLaunchpad.LaunchMode mode,
        string memory name_,
        string memory sym_
    ) internal returns (address) {
        usdc.mint(asCreator, launchpad.CREATION_FEE());
        vm.startPrank(asCreator);
        usdc.approve(address(launchpad), type(uint256).max);
        address tokenAddr = launchpad.createToken(name_, sym_, "ipfs://x", mode, address(0), 0);
        vm.stopPrank();
        return tokenAddr;
    }

    function _migrateByBuyingOut(address token) internal {
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0);
        vm.stopPrank();
    }

    function test_swapMigratedRoute_chargesRoyaltyOnBothLegs() public {
        address creatorA = address(0xA0A0);
        address creatorB = address(0xB0B0);
        address tokenA = _createTokenAs(creatorA, IArcadeLaunchpad.LaunchMode.PUMP, "Alpha", "A");
        address tokenB = _createTokenAs(creatorB, IArcadeLaunchpad.LaunchMode.PUMP, "Bravo", "B");

        _migrateByBuyingOut(tokenA);
        _migrateByBuyingOut(tokenB);

        // Bob now has some tokenA from an unrelated buy
        vm.startPrank(bob);
        usdc.approve(address(launchpad), type(uint256).max);
        uint256 tokensA = launchpad.buyMigrated(tokenA, 200 * 10 ** 6, 0);
        vm.stopPrank();

        // Snapshot AFTER the prior buyMigrated has paid its own royalty
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 ca0 = usdc.balanceOf(creatorA);
        uint256 cb0 = usdc.balanceOf(creatorB);

        // Quote what we're about to do
        (uint256 quotedOut, uint256 quotedRoyalty) =
            launchpad.quoteSwapMigratedRoute(tokenA, tokenB, tokensA);
        assertGt(quotedRoyalty, 0, "quote shows a royalty");
        assertGt(quotedOut, 0, "quote shows an output");

        // Execute the multi-hop swap through the launchpad
        vm.startPrank(bob);
        IERC20(tokenA).approve(address(launchpad), type(uint256).max);
        uint256 receivedB = launchpad.swapMigratedRoute(tokenA, tokenB, tokensA, 0);
        vm.stopPrank();

        assertEq(receivedB, quotedOut, "actual matches quote");

        // Both creators must have been paid a non-zero royalty on their leg
        assertGt(usdc.balanceOf(creatorA), ca0, "creatorA got leg-1 royalty");
        assertGt(usdc.balanceOf(creatorB), cb0, "creatorB got leg-2 royalty");
        // Treasury got 2/3 of the total royalty across both legs
        assertGt(usdc.balanceOf(treasury), t0, "treasury got platform royalty");
        uint256 totalCreatorPaid = (usdc.balanceOf(creatorA) - ca0) + (usdc.balanceOf(creatorB) - cb0);
        uint256 totalPlatformPaid = usdc.balanceOf(treasury) - t0;
        // Platform = 0.20% / 0.30% of total royalty = 2/3
        // Creator  = 0.10% / 0.30% = 1/3
        // So total platform should equal ~2x total creator
        // Each leg rounds independently (royalty floor → 2/3 platform / 1/3 creator floor),
        // so we allow up to 2 wei of rounding drift on the platform vs 2*creator invariant.
        assertApproxEqAbs(totalPlatformPaid, 2 * totalCreatorPaid, 2, "platform = 2x creator");
        assertEq(totalPlatformPaid + totalCreatorPaid, quotedRoyalty, "royalty conserved");
    }

    function test_swapMigratedRoute_revertsOnUsdcLeg() public {
        address tokenA = _createTokenAs(address(0xA0A0), IArcadeLaunchpad.LaunchMode.PUMP, "A", "A");
        _migrateByBuyingOut(tokenA);

        // USDC as either side is invalid — caller should use buyMigrated/sellMigrated.
        vm.expectRevert(ArcadeLaunchpad.UnknownToken.selector);
        launchpad.swapMigratedRoute(address(usdc), tokenA, 1, 0);
        vm.expectRevert(ArcadeLaunchpad.UnknownToken.selector);
        launchpad.swapMigratedRoute(tokenA, address(usdc), 1, 0);
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
