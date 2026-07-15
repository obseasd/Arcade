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

contract MockLaunchToken is ERC20 {
    constructor() ERC20("Launch", "LNCH") {
        _mint(msg.sender, 1_000_000_000e18);
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

    /// Nobody may claim a leg they are not owed.
    function test_launchFee_cannotClaimSomeoneElsesLeg() public {
        usdc.setBlacklisted(creator, true);
        _buy(1_000e6);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        pair.claimLaunchFees(address(usdc));
    }
}
