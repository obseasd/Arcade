// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeV2Pair} from "../src/dex/ArcadeV2Pair.sol";
import {IArcadeV2Pair} from "../src/dex/interfaces/IArcadeV2Pair.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {ArcadeMigratedRouter} from "../src/swap/ArcadeMigratedRouter.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeLaunchToken} from "../src/launchpad/ArcadeLaunchToken.sol";
import {IArcadeV3Factory} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ArcadeLaunchpadTest is Test {
    MockUSDC usdc;
    ArcadeV2Factory factory;
    ArcadeV2Router router;
    ArcadeLaunchpad launchpad;
    ArcadeMigratedRouter migratedRouter;

    address treasury = address(0xBEEF);
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

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
        // Authorize the launchpad to create seed-gated pairs (feeToSetter == this).
        factory.setLaunchpad(address(launchpad));
        // Migrated-route wrappers were extracted to this periphery contract.
        migratedRouter = new ArcadeMigratedRouter(
            IERC20(address(usdc)), address(router), IArcadeLaunchpad(address(launchpad))
        );

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
        assertGt(pairUsdc, 0, "USDC in pair");
        // Audit 2026-07-01: the pair is now seeded at the curve's CLEARING price,
        // so fewer than the full LP allotment is used and the remainder is burned.
        assertLt(pairTokens, launchpad.MIGRATION_LP_TOKENS(), "clearing-scaled seed uses < full allotment");
        // pair price == clearing price: pairUsdc/pairTokens == clearingUsdc/currentTokens,
        // where clearingUsdc = VIRTUAL_USDC_RESERVE + raised (20k) and currentTokens
        // == MIGRATION_LP_TOKENS at 100%. Cross-multiplied to avoid division rounding.
        uint256 clearingUsdc = 5_000e6 + 20_000e6;
        assertApproxEqRel(
            pairUsdc * launchpad.MIGRATION_LP_TOKENS(),
            pairTokens * clearingUsdc,
            1e15, // 0.1%
            "pair seeded at the curve clearing price"
        );
        // The un-seeded remainder of the LP allotment was burned to DEAD.
        assertApproxEqAbs(
            IERC20(token).balanceOf(launchpad.DEAD()),
            launchpad.MIGRATION_LP_TOKENS() - pairTokens,
            1e18,
            "excess LP tokens burned"
        );

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
        usdc.approve(address(migratedRouter), type(uint256).max);
        uint256 tokensOut = migratedRouter.buyMigrated(token, amountIn, 0, block.timestamp + 600);
        vm.stopPrank();

        assertGt(tokensOut, 0, "tokens received");

        // The wrapper royalty is gone; ArcadeV2Pair now charges the fee itself,
        // on the INPUT. A buy's input is USDC, so both legs land in USDC.
        // 0.15% protocol -> factory.feeTo (= treasury), 0.05% -> launchCreator.
        uint256 expectedPlatform = (amountIn * 15) / 10_000; // 0.15 USDC
        uint256 expectedCreator = (amountIn * 5) / 10_000; // 0.05 USDC
        assertEq(usdc.balanceOf(treasury), t0 + expectedPlatform, "pair paid protocol leg");
        assertEq(usdc.balanceOf(creator), c1_0 + (expectedCreator - (expectedCreator * 5_000) / 10_000), "creator1 paid its share + dust");

        // creator2 survives migration: the pair carries the second recipient,
        // mirroring the launchpad's own creator/creator2 model. This launch is
        // CLANKER with creator2 at 50/50, so the 0.05% creator leg splits in
        // half, with creator1 taking the rounding remainder.
        uint256 expectedC2 = (expectedCreator * 5_000) / 10_000;
        assertEq(usdc.balanceOf(creator2), c2_0 + expectedC2, "creator2 paid its share");
    }

    function test_sellMigrated_takesRoyaltyOnOutput() public {
        address token = _createToken(); // PUMP mode, single creator

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0); // migrate
        vm.stopPrank();

        // Bob buys some via the migrated wrapper to acquire tokens
        vm.startPrank(bob);
        usdc.approve(address(migratedRouter), type(uint256).max);
        uint256 bought = migratedRouter.buyMigrated(token, 500 * 10 ** 6, 0, block.timestamp + 600);

        uint256 t0 = usdc.balanceOf(treasury);
        uint256 c0 = usdc.balanceOf(creator);

        IERC20(token).approve(address(migratedRouter), type(uint256).max);
        uint256 received = migratedRouter.sellMigrated(token, bought, 0, block.timestamp + 600);
        vm.stopPrank();

        // A sell's INPUT is the launch token, so the pair's fee is denominated
        // in the TOKEN, not USDC. This is the deliberate cost of input-side
        // skimming: `to` always receives exactly amountOut, which keeps the
        // stock UniswapV2Library bit-exact and amountOutMin honest, at the
        // price of accruing launch-token inventory to be swept off-chain.
        // (An output-side skim would keep the fee in USDC but silently defeat
        // amountOutMin on the stock router: a fund-loss bug. See ArcadeV2Pair.)
        assertGt(received, 0, "received USDC");
        assertEq(usdc.balanceOf(treasury), t0, "no USDC fee on a sell (fee is in TOKEN)");
        assertEq(usdc.balanceOf(creator), c0, "no USDC fee on a sell (fee is in TOKEN)");
        assertGt(IERC20(token).balanceOf(treasury), 0, "protocol leg paid in TOKEN");
        assertGt(IERC20(token).balanceOf(creator), 0, "creator leg paid in TOKEN");
    }

    /// Pins the migration seed and the mcap denominator. No test pinned
    /// `tokensForLP` before, which is exactly why the header comment drifted to
    /// claiming 200M for years while the code seeded 140M, and why marketCap()
    /// silently overstated by ~6.4%.
    function test_migration_seedsClearingPriceAndBurnsExcess() public {
        address token = _createToken();
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0);
        vm.stopPrank();

        // raised ~20,000; usdcForLP = ~17,500 after the 2,500 migration fee.
        // tokensForLP = usdcForLP * 200M / currentUsdc ~= 140M, so ~60M burns.
        // (Not exact: the buy overshoots the cap and is refunded.)
        address pair = launchpad.getTokenState(token).v2Pair;
        uint256 burned = IERC20(token).balanceOf(launchpad.DEAD());
        uint256 pairTokens = IERC20(token).balanceOf(pair);
        uint256 pairUsdc = usdc.balanceOf(pair);

        assertApproxEqRel(burned, 60_000_000 ether, 0.001e18, "~60M burned, NOT 0");
        assertApproxEqRel(pairTokens, 140_000_000 ether, 0.001e18, "pair seeded ~140M, not 200M");
        assertApproxEqRel(pairUsdc, 17_500 * 10 ** 6, 0.001e18, "pair seeded ~17,500 USDC");
        assertEq(burned + pairTokens, 200_000_000 ether, "burn + seed == MIGRATION_LP_TOKENS");

        // mcap must price the CIRCULATING supply, not the 1B minted.
        uint256 mcap = launchpad.marketCap(token);
        uint256 circulating = 1_000_000_000 ether - burned;
        assertEq(mcap, (pairUsdc * circulating) / pairTokens, "mcap prices circulating supply");

        // The old TOTAL_SUPPLY denominator overstated by ~6.4%.
        uint256 overstated = (pairUsdc * 1_000_000_000 ether) / pairTokens;
        assertGt(overstated, mcap, "old denominator was higher");
        assertApproxEqRel(overstated, (mcap * 1064) / 1000, 0.002e18, "overstatement was ~6.4%");
    }

    /// F-1 regression: createToken accepts {creator2 != 0, bps == 0}, and the
    /// pair used to REVERT on it. Since setLaunchCreator runs inside _migrate,
    /// inside the buy that completes the curve, that froze the launch one buy
    /// short of graduation FOREVER, with ~20k USDC of real money in it. Anything
    /// _migrate calls must be total.
    function test_F1_creator2WithZeroBps_stillGraduates() public {
        address token = _createTokenMode(IArcadeLaunchpad.LaunchMode.CLANKER, address(0xDEAD11), 0);

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0); // the buy that migrates
        vm.stopPrank();

        assertTrue(launchpad.getTokenState(token).migrated, "graduated, not bricked");
        // A zero share means "no creator2", not "a creator2 earning nothing".
        assertEq(launchpad.getTokenState(token).creator2, address(0), "creator2 normalised away");
    }

    // F-3's regression test lives in ArcadeV2PairLaunchFee.t.sol
    // (test_launchFee_feeToUnset_isStill30Bps): with feeTo unset the pair must
    // still be a 30bps pool, proven by the stock quote clearing exactly and one
    // wei more reverting on K.
    //
    // A TODO here used to say the test was unwritable -- "my first attempt
    // reverted on the EXACT router quote, which the algebra says is impossible,
    // so the harness is wrong". The harness WAS wrong (routing through the
    // router adds its own accounting); the property is trivially testable
    // against the pair directly. An audit called that out, and it was right:
    // abandoning it left a HIGH (a 15bps pool quoting 30bps, so anyone calling
    // swap() directly pocketed the difference) with no regression cover, behind
    // a note that told the next reader not to try.

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

        (uint256 quoted,,) = launchpad.quoteBuy(token, amountIn);

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
        usdc.approve(address(migratedRouter), type(uint256).max);
        uint256 tokensA = migratedRouter.buyMigrated(tokenA, 200 * 10 ** 6, 0, block.timestamp + 600);
        vm.stopPrank();

        // Snapshot AFTER the prior buyMigrated has paid its own royalty
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 ca0 = usdc.balanceOf(creatorA);
        uint256 cb0 = usdc.balanceOf(creatorB);

        // Quote what we're about to do. quotedRoyalty is now always 0: the
        // wrapper royalty is deleted and each leg's own pair charges the fee
        // in-pool. getAmountsOut already prices the 997/1000 the pair enforces,
        // so the quote needs no extra deduction and stays exact.
        // The second return is the REAL mid-leg USDC, not the dead royalty. It
        // used to assert == 0, which pinned the bug: SwapCard derives the
        // mid-leg slippage floor exclusively from this value and throws when it
        // is 0, so a hardcoded 0 bricked the whole migrated->migrated route in
        // the UI while this test called that correct.
        (uint256 quotedOut, uint256 quotedUsdcMid) =
            migratedRouter.quoteSwapMigratedRoute(tokenA, tokenB, tokensA);
        assertGt(quotedUsdcMid, 0, "usdcMid is derivable, so the mid-leg floor is too");
        assertGt(quotedOut, 0, "quote shows an output");

        // Execute the multi-hop swap through the launchpad
        vm.startPrank(bob);
        IERC20(tokenA).approve(address(migratedRouter), type(uint256).max);
        uint256 receivedB = migratedRouter.swapMigratedRoute(tokenA, tokenB, tokensA, 0, 0, block.timestamp + 600);
        vm.stopPrank();

        assertGt(receivedB, 0, "multi-hop delivered");
        // QUOTE == EXECUTION, to the wei. This assertion was deleted when the
        // quoter's second return changed meaning, and it is the single most
        // load-bearing one here: the whole input-side design rests on the pair
        // delivering EXACTLY the stock library figure, and an output-side skim
        // (the reverted fund-loss bug) would show up right here as
        // execution < quote while every other test stayed green.
        assertEq(receivedB, quotedOut, "execution matches the quote exactly");

        // Leg 1 sells tokenA -> its fee is paid in tokenA (input side).
        // Leg 2 buys tokenB with USDC -> its fee is paid in USDC.
        // So creatorA is paid in tokenA, and the treasury sees USDC from leg 2.
        assertGt(IERC20(tokenA).balanceOf(creatorA), 0, "creatorA paid in tokenA (leg 1 input)");
        assertGt(usdc.balanceOf(treasury), t0, "treasury paid in USDC (leg 2 input)");
        assertGt(usdc.balanceOf(creatorB), cb0, "creatorB paid in USDC (leg 2 input)");
    }

    function test_swapMigratedRoute_revertsOnUsdcLeg() public {
        address tokenA = _createTokenAs(address(0xA0A0), IArcadeLaunchpad.LaunchMode.PUMP, "A", "A");
        _migrateByBuyingOut(tokenA);

        // USDC as either side is invalid - caller should use buyMigrated/sellMigrated.
        // Audit renamed this from UnknownToken to InvalidRoute since the tokens
        // ARE known; the route shape is what's wrong.
        vm.expectRevert(ArcadeLaunchpad.InvalidRoute.selector);
        migratedRouter.swapMigratedRoute(address(usdc), tokenA, 1, 0, 0, block.timestamp + 600);
        vm.expectRevert(ArcadeLaunchpad.InvalidRoute.selector);
        migratedRouter.swapMigratedRoute(tokenA, address(usdc), 1, 0, 0, block.timestamp + 600);
    }

    /// THE MID-LEG SANDWICH GUARD, which had NO test anywhere (audit flagged the
    /// recurring "guard untested" pattern). swapMigratedRoute enforces
    /// usdcMidMin on the intermediate USDC of the two hops -- the only thing
    /// stopping a sandwicher who moves just the tokenIn/USDC pool from driving
    /// usdcMid low and scraping past the final minOut (audit 2026-06-11 #10). A
    /// floor above the achievable mid MUST revert MidSlippage.
    function test_swapMigratedRoute_midLegGuard_revertsWhenFloorTooHigh() public {
        address tokenA = _createTokenAs(address(0xA0A0), IArcadeLaunchpad.LaunchMode.PUMP, "Alpha", "A");
        address tokenB = _createTokenAs(address(0xB0B0), IArcadeLaunchpad.LaunchMode.PUMP, "Bravo", "B");
        _migrateByBuyingOut(tokenA);
        _migrateByBuyingOut(tokenB);

        vm.startPrank(bob);
        usdc.approve(address(migratedRouter), type(uint256).max);
        uint256 tokensA = migratedRouter.buyMigrated(tokenA, 200 * 10 ** 6, 0, block.timestamp + 600);

        (, uint256 quotedUsdcMid) = migratedRouter.quoteSwapMigratedRoute(tokenA, tokenB, tokensA);
        assertGt(quotedUsdcMid, 0, "there is a real mid");

        IERC20(tokenA).approve(address(migratedRouter), type(uint256).max);
        // A floor ABOVE the achievable mid must revert. With no other trades the
        // executed mid == the quote, so quote+1 is unreachable.
        vm.expectRevert(ArcadeMigratedRouter.MidSlippage.selector);
        migratedRouter.swapMigratedRoute(
            tokenA, tokenB, tokensA, 0, quotedUsdcMid + 1, block.timestamp + 600
        );

        // And a realistic 97% floor clears -- the guard does not over-reject.
        uint256 got = migratedRouter.swapMigratedRoute(
            tokenA, tokenB, tokensA, 0, (quotedUsdcMid * 97) / 100, block.timestamp + 600
        );
        assertGt(got, 0, "realistic floor clears");
        vm.stopPrank();
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

    // ============= H-05: migration platform fee skim =====================

    function test_H05_migrationFeeSkimmedToTreasury() public {
        address token = _createToken();
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        // Drain the curve. Track buyer fees separately from the migration fee.
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0);
        vm.stopPrank();

        ArcadeLaunchpad.TokenState memory state = launchpad.getTokenState(token);
        assertTrue(state.migrated, "migrated");

        uint256 pairUsdc = usdc.balanceOf(state.v2Pair);
        uint256 treasuryAfter = usdc.balanceOf(treasury);

        // Treasury receives BOTH the trade fees (50% of 1% on each buy) AND
        // the migration fee (2,500 USDC) on the migrating buy. The V2 pair
        // holds the LP seed. Allow up to 2 wei drift on the seed value to
        // account for the documented L-17 capped-buy ceiling (1-2 wei the
        // curve rounds in the contract's favour at migration boundary).
        uint256 expectedSeed = 20_000 * 10 ** 6 - launchpad.MIGRATION_FEE();
        assertApproxEqAbs(pairUsdc, expectedSeed, 2, "V2 pair seeded with raised - MIGRATION_FEE +/- dust");
        assertGe(treasuryAfter - treasuryBefore, launchpad.MIGRATION_FEE(), "treasury got at least MIGRATION_FEE");
    }

    // ============= M-09: V2 pair pre-donation skim ========================

    function test_M09_v2PairPreDonationSkimmedToDead() public {
        // New invariant (2026-07-05): the launchpad pre-creates the USDC/token
        // pair seed-gated to itself at token creation, so an attacker cannot
        // mint or sync it. A raw USDC donation to the pair is skimmed to DEAD at
        // migration (reserves are 0, sync is gated), so the pool opens at exactly
        // the clearing price and the donation never dilutes or mis-prices the seed.
        address token = _createToken();
        address pair = factory.getPair(address(usdc), token);
        assertTrue(pair != address(0), "launchpad pre-created the gated pair");

        uint256 donation = 5_000 * 10 ** 6;
        vm.prank(bob);
        usdc.transfer(pair, donation);

        uint256 deadBefore = usdc.balanceOf(launchpad.DEAD());

        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0);
        vm.stopPrank();

        // Pair holds ONLY the seed; the donation was skimmed out to DEAD.
        uint256 pairUsdc = usdc.balanceOf(pair);
        uint256 expectedSeed = 20_000 * 10 ** 6 - launchpad.MIGRATION_FEE();
        assertApproxEqAbs(pairUsdc, expectedSeed, 2, "pair holds only the seed (donation skimmed)");
        assertGe(usdc.balanceOf(launchpad.DEAD()) - deadBefore, donation, "donation skimmed to DEAD");
    }

    /// @notice Audit 2026-07-05: the launchpad pre-creates the canonical
    /// USDC/token pair seed-gated to itself at token creation, closing the
    /// pre-mint / poisoning vector (audit L-1 / H-1) at the source: an attacker
    /// can neither re-create the pair nor perform its first mint/sync. Migration
    /// seeds it directly at the clearing price and can never brick.
    function test_H1_v2PairPreMint_blockedAndMigrationSeedsCleanly() public {
        address token = _createToken();
        address pair = factory.getPair(address(usdc), token);
        assertTrue(pair != address(0), "gated pair pre-created at token creation");

        // Attacker cannot re-create the pair (already exists) ...
        vm.expectRevert();
        factory.createPair(address(usdc), token);

        // ... and cannot perform the first mint or sync (seed-gated to launchpad).
        deal(address(usdc), bob, 1_000 * 10 ** 6);
        vm.startPrank(bob);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100 * 10 ** 6, 0);
        uint256 bobTokenBal = IERC20(token).balanceOf(bob);
        usdc.transfer(pair, 100 * 10 ** 6);
        IERC20(token).transfer(pair, bobTokenBal);
        vm.expectRevert(); // Forbidden: only the launchpad (seedGate) may first-mint
        IArcadeV2Pair(pair).mint(bob);
        vm.expectRevert(); // sync is gated too while unseeded
        IArcadeV2Pair(pair).sync();
        vm.stopPrank();

        uint256 treasuryBefore = usdc.balanceOf(treasury);

        // Graduate the curve: migration completes and seeds the locked DEAD LP.
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        launchpad.buy(token, 100_000 * 10 ** 6, 0);
        vm.expectRevert(); // already migrated
        launchpad.buy(token, 1_000 * 10 ** 6, 0);
        vm.stopPrank();

        // The seed is locked in DEAD's LP; the attacker captured nothing.
        assertGt(IERC20(pair).balanceOf(launchpad.DEAD()), 0, "DEAD holds the seeded LP");
        assertEq(IERC20(pair).balanceOf(bob), 0, "attacker holds no LP");
        // Treasury got the migration fee (seed is exact now; no refund path).
        assertGe(
            usdc.balanceOf(treasury) - treasuryBefore,
            launchpad.MIGRATION_FEE(),
            "treasury got MIGRATION_FEE"
        );
    }

    // ===== Audit 2026-07-05: createPair no-code guard (front-run DoS regression) =====

    function test_createPair_rejectsUndeployedToken_launchStillWorks() public {
        // An attacker who predicts a launchpad token's deterministic pair slot
        // must NOT be able to pre-occupy it via the permissionless createPair:
        // at front-run time the predicted token has no code, so createPair reverts.
        address notDeployed = address(0xBEEF);
        assertEq(notDeployed.code.length, 0, "precondition: no code");
        vm.expectRevert(); // NoCode()
        factory.createPair(address(usdc), notDeployed);

        // And a normal PUMP launch still creates its gated pair inside createToken.
        address token = _createToken();
        assertTrue(factory.getPair(address(usdc), token) != address(0), "gated pair created by launch");
    }

    // ===== Audit 2026-07-05: creator2 is CLANKER-only (matches NatSpec) =====

    function test_pumpMode_ignoresCreator2() public {
        address token = _createTokenMode(IArcadeLaunchpad.LaunchMode.PUMP, bob, 5000);
        IArcadeLaunchpad.TokenState memory s = launchpad.getTokenState(token);
        assertEq(s.creator2, address(0), "PUMP ignores creator2");
        assertEq(s.creator2ShareBps, 0, "PUMP zeroes creator2ShareBps");
    }

    function test_clankerMode_honorsCreator2() public {
        address token = _createTokenMode(IArcadeLaunchpad.LaunchMode.CLANKER, bob, 5000);
        IArcadeLaunchpad.TokenState memory s = launchpad.getTokenState(token);
        assertEq(s.creator2, bob, "CLANKER honors creator2");
        assertEq(s.creator2ShareBps, 5000, "CLANKER keeps creator2ShareBps");
    }

    // ============= L-12: setV3Infra rejects zero addresses ===============

    function test_L12_setV3Infra_rejectsZero() public {
        // Build a fresh launchpad so v3Locker is still address(0).
        ArcadeLaunchpad fresh = new ArcadeLaunchpad(
            IERC20(address(usdc)), factory, address(router), treasury, IArcadeV3Factory(address(0)), address(0)
        );
        vm.expectRevert(ArcadeLaunchpad.ZeroAmount.selector);
        fresh.setV3Infra(address(0), address(0xBEEF), address(0xCAFE));
        vm.expectRevert(ArcadeLaunchpad.ZeroAmount.selector);
        fresh.setV3Infra(address(0xBEEF), address(0), address(0xCAFE));
        vm.expectRevert(ArcadeLaunchpad.ZeroAmount.selector);
        fresh.setV3Infra(address(0xBEEF), address(0xCAFE), address(0));
    }
}
