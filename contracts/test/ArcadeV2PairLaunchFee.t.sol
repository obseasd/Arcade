// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {IArcadeV2Pair} from "../src/dex/interfaces/IArcadeV2Pair.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPairLaunchFee {
    function setLaunchCreator(address creator, address creator2, uint16 creator2Bps) external;
    function mint(address to) external returns (uint256);
    function burn(address to) external returns (uint256, uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function skim(address to) external;
    function sync() external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function pendingLaunchFees(address token, address to) external view returns (uint256);
    function pendingLaunchFeeTotal(address token) external view returns (uint256);
    function claimLaunchFees(address token) external returns (uint256);
}

/// Mirrors Circle USDC: transfer to a blacklisted address REVERTS, it does not
/// return false. That is the trigger for the whole deferral path, and no mock
/// in this repo modelled it on the V2 side -- which is why the brick below
/// could ship without a single red test.
contract BlacklistUSDC is ERC20 {
    mapping(address => bool) public blacklisted;

    constructor() ERC20("Blacklist USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function setBlacklisted(address a, bool b) external {
        blacklisted[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blacklisted[from] && !blacklisted[to], "BLACKLISTED");
        super._update(from, to, value);
    }
}

/// Blacklistable too: without this the SELL side (fee1Paid, the leg that
/// accrues in the LAUNCH TOKEN) could never be deferred in a test, so half the
/// deferral logic was unreachable from the suite.
contract MockLaunchToken is ERC20 {
    mapping(address => bool) public blacklisted;

    constructor() ERC20("Launch", "LNCH") {
        _mint(msg.sender, 1_000_000_000e18);
    }

    function setBlacklisted(address a, bool b) external {
        blacklisted[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blacklisted[from] && !blacklisted[to], "BLACKLISTED");
        super._update(from, to, value);
    }
}

/**
 * The graduated pair pays its protocol + creator fee legs INSIDE swap(), and
 * `launchCreator` is set-once with no setter. A hard transfer there meant that
 * Circle blacklisting the creator reverted EVERY USDC-in swap on that pair,
 * forever: the market goes sell-only and dies, unrecoverably, taking the
 * creator's own future fees with it.
 *
 * This is the sixth instance of hard-transfer-to-an-immutable-recipient in this
 * codebase. The rule these tests pin: the payer ALWAYS pays, only the
 * destination may defer.
 *
 * This contract IS the launchpad (it calls createPairGated), which is how it
 * gets the seedGate needed to seed and to call setLaunchCreator.
 */
contract ArcadeV2PairLaunchFeeTest is Test {
    BlacklistUSDC usdc;
    MockLaunchToken tkn;
    ArcadeV2Factory factory;
    IPairLaunchFee pair;

    address creator = address(0xC0FFEE);
    address feeTo = address(0xFEE);
    address trader = address(0xB0B);

    function setUp() public {
        usdc = new BlacklistUSDC();
        tkn = new MockLaunchToken();
        factory = new ArcadeV2Factory(address(this));
        factory.setLaunchpad(address(this)); // this test IS the launchpad
        factory.setFeeTo(feeTo);

        pair = IPairLaunchFee(factory.createPairGated(address(usdc), address(tkn)));
        pair.setLaunchCreator(creator, address(0), 0);

        usdc.mint(address(pair), 100_000e6);
        tkn.transfer(address(pair), 100_000_000e18);
        pair.mint(address(this));

        usdc.mint(trader, 10_000e6);
    }

    /// Buy `usdcIn` worth, computing the output with the STOCK 997/1000 curve.
    function _buy(uint256 usdcIn) internal returns (uint256 out) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool usdcIs0 = pair.token0() == address(usdc);
        (uint256 rIn, uint256 rOut) = usdcIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inWithFee = usdcIn * 997;
        out = (inWithFee * rOut) / (rIn * 1000 + inWithFee);

        vm.prank(trader);
        usdc.transfer(address(pair), usdcIn);
        (uint256 a0, uint256 a1) = usdcIs0 ? (uint256(0), out) : (out, uint256(0));
        pair.swap(a0, a1, trader, "");
    }

    /// Baseline: a healthy creator is paid straight through, nothing deferred.
    function test_launchFee_healthyCreator_paysDirect() public {
        _buy(1_000e6);
        assertGt(usdc.balanceOf(creator), 0, "creator paid");
        assertGt(usdc.balanceOf(feeTo), 0, "protocol paid");
        assertEq(pair.pendingLaunchFeeTotal(address(usdc)), 0, "nothing deferred");
    }

    /// THE BRICK: a blacklisted creator must not stop the market. Pre-fix this
    /// reverted, and since launchCreator is set-once with no setter it reverted
    /// FOREVER.
    function test_launchFee_blacklistedCreator_doesNotBrickTheMarket() public {
        usdc.setBlacklisted(creator, true);
        uint256 out = _buy(1_000e6);
        assertGt(out, 0, "the swap still clears");
        assertGt(pair.pendingLaunchFees(address(usdc), creator), 0, "creator's leg deferred");
        // The protocol leg is unaffected by the creator's problem.
        assertGt(usdc.balanceOf(feeTo), 0, "protocol still paid");
    }

    /// A blacklisted feeTo must not brick it either, and must not take the
    /// creator's leg down with it.
    function test_launchFee_blacklistedFeeTo_defersOnlyItsOwnLeg() public {
        usdc.setBlacklisted(feeTo, true);
        _buy(1_000e6);
        assertGt(pair.pendingLaunchFees(address(usdc), feeTo), 0, "protocol leg deferred");
        assertGt(usdc.balanceOf(creator), 0, "creator still paid directly");
    }

    /// Deferral is not forgiveness: the deferred fee is claimable once the
    /// recipient can receive again, and only by that recipient.
    function test_launchFee_deferredIsClaimableOnceUnblocked() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6);
        uint256 owed = pair.pendingLaunchFees(address(usdc), creator);
        assertGt(owed, 0, "owed");

        usdc.setBlacklisted(creator, false);
        vm.prank(creator);
        pair.claimLaunchFees(address(usdc));
        assertEq(usdc.balanceOf(creator), owed, "creator claimed exactly what was owed");
        assertEq(pair.pendingLaunchFees(address(usdc), creator), 0, "ledger cleared");
        assertEq(pair.pendingLaunchFeeTotal(address(usdc)), 0, "total cleared");
    }

    /// THE THEFT VECTOR THE DEFERRAL CREATES. skim() pays out
    /// `balanceOf - reserve`, and a deferred fee is EXACTLY that difference: it
    /// sits in the pair while _update has already excluded it from reserves. If
    /// skim() does not net out pendingLaunchFeeTotal, the first passer-by walks
    /// off with the creator's fees. (The CCTP receiver shipped this same bug:
    /// its leftover sweep ate the deferred fee.)
    function test_launchFee_skimCannotStealTheDeferredFee() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6);
        uint256 owed = pair.pendingLaunchFees(address(usdc), creator);
        assertGt(owed, 0, "something is deferred");

        address thief = address(0xBAD);
        pair.skim(thief);
        assertEq(usdc.balanceOf(thief), 0, "skim must not touch a deferred fee");

        // And it is still there for its rightful owner.
        usdc.setBlacklisted(creator, false);
        vm.prank(creator);
        pair.claimLaunchFees(address(usdc));
        assertEq(usdc.balanceOf(creator), owed, "still fully claimable after a skim");
    }

    /// sync() must not book a deferred fee as pool depth: it is held here but
    /// OWED. If it did, the later claim would drop the balance BELOW the
    /// recorded reserve, underflowing skim() and leaving the pair quoting
    /// against depth it does not have.
    function test_launchFee_syncDoesNotAbsorbTheDeferredFee() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6);
        uint256 owed = pair.pendingLaunchFees(address(usdc), creator);

        bool usdcIs0 = pair.token0() == address(usdc);
        (uint112 r0Before, uint112 r1Before,) = pair.getReserves();
        uint256 usdcReserveBefore = usdcIs0 ? r0Before : r1Before;

        pair.sync();
        (uint112 r0After, uint112 r1After,) = pair.getReserves();
        uint256 usdcReserveAfter = usdcIs0 ? r0After : r1After;
        assertEq(usdcReserveAfter, usdcReserveBefore, "sync must not absorb the owed fee");

        // The claim still works afterwards, which it would not if sync had
        // counted the fee as reserves.
        usdc.setBlacklisted(creator, false);
        vm.prank(creator);
        pair.claimLaunchFees(address(usdc));
        assertEq(usdc.balanceOf(creator), owed, "claim survives a sync");
    }

    /// CRITICAL, and the exact gap this file had: the deferral's theft vector
    /// was closed on skim()/sync() and left open on mint()/burn(), the two
    /// functions no test here touched.
    ///
    /// mint() read raw balanceOf and passed it to _update, booking the OWED fee
    /// as reserves. `balanceOf - reserve` then collapses to 0 while
    /// pendingLaunchFeeTotal stays positive, so skim() underflow-reverts
    /// forever, and the creator's later claim drops the balance BELOW the
    /// recorded reserve. mint() is permissionless once seeded and this pair's
    /// own docs call dust-poking expected, so one poke did it.
    function test_launchFee_mintDoesNotAbsorbTheDeferredFee() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6);
        uint256 owed = pair.pendingLaunchFees(address(usdc), creator);
        assertGt(owed, 0, "something is deferred");

        // A dust poke.
        usdc.mint(address(pair), 1_000e6);
        tkn.transfer(address(pair), 1_000_000e18);
        pair.mint(address(this));

        // skim() must still work -- it underflow-reverted before this fix.
        pair.skim(address(0xBAD));

        // And the creator is still made whole.
        usdc.setBlacklisted(creator, false);
        vm.prank(creator);
        pair.claimLaunchFees(address(usdc));
        assertEq(usdc.balanceOf(creator), owed, "creator still paid in full after a mint");
    }

    /// CRITICAL: burn() computed the LP's pro-rata slice from raw balanceOf, so
    /// it paid out a share of the creator's owed fee. Mint-then-burn in one
    /// block extracted it for the cost of gas, and the ledger still promised the
    /// creator an amount the pair no longer held -- so the residue came out of
    /// the remaining LPs.
    function test_launchFee_burnCannotStealTheDeferredFee() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6);
        uint256 owed = pair.pendingLaunchFees(address(usdc), creator);
        assertGt(owed, 0, "something is deferred");

        // Attacker mints a large LP position, then immediately burns it.
        address attacker = address(0xBAD);
        usdc.mint(attacker, 100_000e6);
        vm.prank(attacker);
        usdc.transfer(address(pair), 100_000e6);
        tkn.transfer(address(pair), 100_000_000e18);
        uint256 lp = pair.mint(attacker);

        uint256 usdcIn = 100_000e6;
        vm.prank(attacker);
        IERC20(address(pair)).transfer(address(pair), lp);
        pair.burn(attacker);

        // Out must never exceed in: the creator's fee is not theirs to take.
        assertLe(usdc.balanceOf(attacker), usdcIn, "mint+burn must not profit from the owed fee");

        // And the creator is still fully backed.
        usdc.setBlacklisted(creator, false);
        vm.prank(creator);
        pair.claimLaunchFees(address(usdc));
        assertEq(usdc.balanceOf(creator), owed, "creator still paid in full after a burn");
    }

    /// Sell a launch token: the fee accrues in the LAUNCH TOKEN (fee1Paid), the
    /// leg no test reached because the mock could not blacklist. A blacklisted
    /// creator must not brick SELLS either.
    function test_launchFee_sellSide_blacklistedCreator_defers() public {
        tkn.setBlacklisted(creator, true);
        // Sell 1000 launch tokens back into the pair.
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool usdcIs0 = pair.token0() == address(usdc);
        (uint256 rIn, uint256 rOut) = usdcIs0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        uint256 amtIn = 1_000e18;
        uint256 inWithFee = amtIn * 997;
        uint256 out = (inWithFee * rOut) / (rIn * 1000 + inWithFee);

        tkn.transfer(address(pair), amtIn);
        (uint256 a0, uint256 a1) = usdcIs0 ? (out, uint256(0)) : (uint256(0), out);
        pair.swap(a0, a1, trader, "");

        assertGt(pair.pendingLaunchFees(address(tkn), creator), 0, "sell-side leg deferred");
        assertGt(usdc.balanceOf(trader), 0, "the sell still cleared");

        tkn.setBlacklisted(creator, false);
        uint256 owed = pair.pendingLaunchFees(address(tkn), creator);
        vm.prank(creator);
        pair.claimLaunchFees(address(tkn));
        assertEq(tkn.balanceOf(creator), owed, "creator claimed the launch-token leg");
    }

    /// The creator2 split was restored post-migration but never exercised under
    /// deferral: every other test uses setLaunchCreator(creator, 0, 0). A
    /// blacklisted creator2 must defer ONLY its own share.
    function test_launchFee_creator2_blacklisted_defersOnlyItsShare() public {
        // Fresh pair with a 50/50 creator split.
        BlacklistUSDC u2 = new BlacklistUSDC();
        MockLaunchToken t2 = new MockLaunchToken();
        IPairLaunchFee p2 = IPairLaunchFee(factory.createPairGated(address(u2), address(t2)));
        address creator2 = address(0xC2);
        p2.setLaunchCreator(creator, creator2, 5_000);
        u2.mint(address(p2), 100_000e6);
        t2.transfer(address(p2), 100_000_000e18);
        p2.mint(address(this));
        u2.mint(trader, 10_000e6);

        u2.setBlacklisted(creator2, true);

        (uint112 r0, uint112 r1,) = p2.getReserves();
        bool usdcIs0 = p2.token0() == address(u2);
        (uint256 rIn, uint256 rOut) = usdcIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 usdcIn = 1_000e6;
        uint256 inWithFee = usdcIn * 997;
        uint256 out = (inWithFee * rOut) / (rIn * 1000 + inWithFee);
        vm.prank(trader);
        u2.transfer(address(p2), usdcIn);
        (uint256 a0, uint256 a1) = usdcIs0 ? (uint256(0), out) : (out, uint256(0));
        p2.swap(a0, a1, trader, "");

        assertGt(p2.pendingLaunchFees(address(u2), creator2), 0, "creator2's share deferred");
        assertGt(u2.balanceOf(creator), 0, "creator1 still paid directly");
        assertGt(u2.balanceOf(feeTo), 0, "protocol still paid directly");
    }

    /// CRITICAL, and the single step every other test in this file was missing:
    /// a SECOND swap after a deferral.
    ///
    /// swap() derives amount0In from balanceOf, and that read was the one place
    /// the netting was not applied -- so the owed fee was credited as fresh
    /// trader input. A passer-by sending ZERO tokens gets paid out against the
    /// creator's money. Every test here did exactly one swap, which is why 11
    /// green tests sat on top of this.
    function test_launchFee_deferredFee_isNotCreditedAsInputOnTheNextSwap() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6); // defers the creator's leg
        assertGt(pair.pendingLaunchFees(address(usdc), creator), 0, "something is deferred");

        // A thief sends NOTHING and asks for tokens.
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool usdcIs0 = pair.token0() == address(usdc);
        (uint256 rIn, uint256 rOut) = usdcIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        // Whatever the owed fee would buy if it were counted as input.
        uint256 owed = pair.pendingLaunchFees(address(usdc), creator);
        uint256 inWithFee = owed * 997;
        uint256 stealable = (inWithFee * rOut) / (rIn * 1000 + inWithFee);
        assertGt(stealable, 0, "the owed fee would buy something if miscounted");

        address thief = address(0xBAD);
        (uint256 a0, uint256 a1) = usdcIs0 ? (uint256(0), stealable) : (stealable, uint256(0));
        vm.expectRevert(); // InsufficientInputAmount: nothing was sent
        pair.swap(a0, a1, thief, "");
        assertEq(tkn.balanceOf(thief), 0, "a zero-input swap must pay nobody");
    }

    /// The invariant must survive an ORDINARY second swap -- no attacker, no
    /// donation. This broke on a plain honest sell, which then underflow-bricked
    /// skim() and let claimLaunchFees drop the balance below the reserve.
    function test_launchFee_invariantSurvivesASecondSwap() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6);
        _buy(1_000e6); // the second swap: this is the step that was untested

        uint256 pending = pair.pendingLaunchFeeTotal(address(usdc));
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 reserveUsdc = pair.token0() == address(usdc) ? r0 : r1;
        uint256 held = usdc.balanceOf(address(pair));
        assertGe(held - reserveUsdc, pending, "pending must stay backed by balanceOf - reserve");

        // skim() must not be bricked, and the creator must still be made whole
        // without the balance ever dropping below the reserve.
        pair.skim(address(0xBAD));
        usdc.setBlacklisted(creator, false);
        vm.prank(creator);
        uint256 got = pair.claimLaunchFees(address(usdc));
        assertEq(got, pending, "creator claimed exactly what was owed");
        (uint112 n0, uint112 n1,) = pair.getReserves();
        uint256 reserveAfter = pair.token0() == address(usdc) ? n0 : n1;
        assertGe(usdc.balanceOf(address(pair)), reserveAfter, "balance never drops below the reserve");
    }

    /// F-3 REGRESSION, the one I abandoned with a TODO claiming "my first
    /// attempt reverted on the EXACT router quote, which the algebra says is
    /// impossible -- so the harness is wrong". An audit proved the test is
    /// perfectly writable; the harness was wrong, and giving up on it left a
    /// HIGH (a 15bps pool quoting 30bps, i.e. anyone calling swap() directly
    /// pocketed the difference) with no regression cover.
    ///
    /// The property: with feeTo UNSET the pair must STILL be a 30bps pool. The
    /// old code derived the K coefficient from a hardcoded constant, so an unset
    /// feeTo silently made it 15bps. Prove the stock 997/1000 quote is exactly
    /// deliverable and one wei more is not.
    function test_launchFee_feeToUnset_isStill30Bps() public {
        factory.setFeeTo(address(0)); // the trigger: no protocol leg
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool usdcIs0 = pair.token0() == address(usdc);
        (uint256 rIn, uint256 rOut) = usdcIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        uint256 usdcIn = 1_000e6;
        // The STOCK library figure, verbatim.
        uint256 inWithFee = usdcIn * 997;
        uint256 exact = (inWithFee * rOut) / (rIn * 1000 + inWithFee);

        // One wei MORE than stock must revert on K. If the pair had silently
        // become a 15bps pool it would happily deliver it.
        vm.prank(trader);
        usdc.transfer(address(pair), usdcIn);
        (uint256 b0, uint256 b1) = usdcIs0 ? (uint256(0), exact + 1) : (exact + 1, uint256(0));
        vm.expectRevert(); // KInvariant
        pair.swap(b0, b1, trader, "");

        // And the exact stock quote must clear.
        (uint256 a0, uint256 a1) = usdcIs0 ? (uint256(0), exact) : (exact, uint256(0));
        pair.swap(a0, a1, trader, "");
        assertEq(tkn.balanceOf(trader), exact, "the stock quote is exactly deliverable");
        // The creator leg was still charged; only the protocol leg vanished.
        assertGt(usdc.balanceOf(creator), 0, "creator still paid with feeTo unset");
    }

    /// Nobody may claim a leg they are not owed.
    function test_launchFee_cannotClaimSomeoneElsesLeg() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        pair.claimLaunchFees(address(usdc));
    }
}
