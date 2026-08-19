// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StaircaseVestingVault} from "../v4src/StaircaseVestingVault.sol";
import {IStaircaseVestingVault} from "../v4src/interfaces/IStaircaseVestingVault.sol";

/// Simple mintable ERC20 for tests.
contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Malicious token that attempts to re-enter `claim` on transfer. Proves the
/// nonReentrant guard (and CEI) hold under a hostile token.
contract ReentrantToken is ERC20 {
    StaircaseVestingVault public vault;
    uint256 public vestId;
    bool public attack;

    constructor() ERC20("Re", "RE") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function arm(StaircaseVestingVault v, uint256 id) external {
        vault = v;
        vestId = id;
        attack = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attack && from == address(vault)) {
            // Re-enter mid-transfer; must revert (ReentrancyGuard) and bubble.
            attack = false; // avoid infinite recursion if the guard were absent
            vault.claim(vestId);
        }
    }
}

contract StaircaseVestingVaultTest is Test {
    StaircaseVestingVault vault;
    MockToken token;

    address constant LAUNCHPAD = address(0x1AECD);
    address constant BENEFICIARY = address(0xBEEF);
    address constant STRANGER = address(0x5721A);

    uint256 constant AMOUNT = 1_000_000e18;
    uint64 t0; // reference "now"

    function setUp() public {
        vault = new StaircaseVestingVault(LAUNCHPAD);
        token = new MockToken();
        vm.warp(1_000_000); // sane non-zero base time
        t0 = uint64(block.timestamp);
    }

    // ----- helpers -------------------------------------------------------

    /// A well-formed 4-step curve: 25% / 50% / 75% / 100% at +1d..+4d.
    function _quarterSteps() internal view returns (IStaircaseVestingVault.Step[] memory s) {
        s = new IStaircaseVestingVault.Step[](4);
        s[0] = IStaircaseVestingVault.Step(t0 + 1 days, 2500);
        s[1] = IStaircaseVestingVault.Step(t0 + 2 days, 5000);
        s[2] = IStaircaseVestingVault.Step(t0 + 3 days, 7500);
        s[3] = IStaircaseVestingVault.Step(t0 + 4 days, 10000);
    }

    /// Fund the vault (launchpad pre-transfers) and create a vest for `amount`.
    function _createFunded(uint256 amount, IStaircaseVestingVault.Step[] memory steps)
        internal
        returns (uint256 id)
    {
        token.mint(address(vault), amount);
        vm.prank(LAUNCHPAD);
        id = vault.createVest(address(token), BENEFICIARY, amount, steps);
    }

    // ----- lifecycle -----------------------------------------------------

    function test_FullLifecycle_TrancheBoundaries() public {
        uint256 id = _createFunded(AMOUNT, _quarterSteps());

        // Nothing before the first step.
        assertEq(vault.vestedAmount(id), 0);
        assertEq(vault.claimable(id), 0);

        // Just before step 1: still 0.
        vm.warp(t0 + 1 days - 1);
        assertEq(vault.claimable(id), 0);

        // Step 1 boundary: 25%.
        vm.warp(t0 + 1 days);
        assertEq(vault.vestedAmount(id), AMOUNT / 4);
        assertEq(vault.claimable(id), AMOUNT / 4);

        // Between steps stays flat (staircase, not linear).
        vm.warp(t0 + 1 days + 12 hours);
        assertEq(vault.vestedAmount(id), AMOUNT / 4);

        // Step 2: 50%.
        vm.warp(t0 + 2 days);
        assertEq(vault.vestedAmount(id), AMOUNT / 2);

        // Step 3: 75%.
        vm.warp(t0 + 3 days);
        assertEq(vault.vestedAmount(id), (AMOUNT * 3) / 4);

        // Step 4 and after: 100% exactly.
        vm.warp(t0 + 4 days);
        assertEq(vault.vestedAmount(id), AMOUNT);
        vm.warp(t0 + 400 days);
        assertEq(vault.vestedAmount(id), AMOUNT);
    }

    function test_ClaimAccounting_AcrossSteps() public {
        uint256 id = _createFunded(AMOUNT, _quarterSteps());

        // Claim at 25%.
        vm.warp(t0 + 1 days);
        vault.claim(id);
        assertEq(token.balanceOf(BENEFICIARY), AMOUNT / 4);
        assertEq(vault.claimable(id), 0);

        // Claim again immediately: no-op, no revert, no extra transfer.
        vault.claim(id);
        assertEq(token.balanceOf(BENEFICIARY), AMOUNT / 4);

        // Advance to 75% and claim the delta only (50% of total).
        vm.warp(t0 + 3 days);
        assertEq(vault.claimable(id), (AMOUNT * 3) / 4 - AMOUNT / 4);
        vault.claim(id);
        assertEq(token.balanceOf(BENEFICIARY), (AMOUNT * 3) / 4);

        // Finish.
        vm.warp(t0 + 4 days);
        vault.claim(id);
        assertEq(token.balanceOf(BENEFICIARY), AMOUNT);
        assertEq(vault.claimable(id), 0);
        assertEq(token.balanceOf(address(vault)), 0);

        // Over-claim after full payout: no-op.
        vm.warp(t0 + 999 days);
        vault.claim(id);
        assertEq(token.balanceOf(BENEFICIARY), AMOUNT);
    }

    function test_SingleStepCliff() public {
        IStaircaseVestingVault.Step[] memory s = new IStaircaseVestingVault.Step[](1);
        s[0] = IStaircaseVestingVault.Step(t0 + 30 days, 10000);
        uint256 id = _createFunded(AMOUNT, s);

        vm.warp(t0 + 30 days - 1);
        assertEq(vault.vestedAmount(id), 0);
        vm.warp(t0 + 30 days);
        assertEq(vault.vestedAmount(id), AMOUNT);
    }

    // ----- multiple vests ------------------------------------------------

    function test_MultipleVests_SameToken_Isolated() public {
        uint256 id1 = _createFunded(AMOUNT, _quarterSteps());

        // Second vest, same token, different beneficiary, different amount.
        uint256 amount2 = 400e18;
        IStaircaseVestingVault.Step[] memory s2 = new IStaircaseVestingVault.Step[](2);
        s2[0] = IStaircaseVestingVault.Step(t0 + 10 days, 3000);
        s2[1] = IStaircaseVestingVault.Step(t0 + 20 days, 10000);
        token.mint(address(vault), amount2);
        vm.prank(LAUNCHPAD);
        uint256 id2 = vault.createVest(address(token), STRANGER, amount2, s2);

        assertTrue(id1 != id2);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(vault.nextVestId(), 3);

        // At +1 day: vest1 at 25%, vest2 still 0.
        vm.warp(t0 + 1 days);
        assertEq(vault.vestedAmount(id1), AMOUNT / 4);
        assertEq(vault.vestedAmount(id2), 0);

        // At +10 days: vest1 fully vested (past its last step), vest2 at 30%.
        vm.warp(t0 + 10 days);
        assertEq(vault.vestedAmount(id1), AMOUNT);
        assertEq(vault.vestedAmount(id2), (amount2 * 3000) / 10000);

        // Claims are isolated and pay the correct beneficiary.
        vault.claim(id2);
        assertEq(token.balanceOf(STRANGER), (amount2 * 3000) / 10000);
        assertEq(token.balanceOf(BENEFICIARY), 0);
    }

    // ----- permissionless claim pays beneficiary -------------------------

    function test_PermissionlessClaim_PaysBeneficiary() public {
        uint256 id = _createFunded(AMOUNT, _quarterSteps());
        vm.warp(t0 + 2 days);

        // A random third party triggers the claim...
        vm.prank(STRANGER);
        vault.claim(id);

        // ...but the funds land with the beneficiary, not the caller.
        assertEq(token.balanceOf(BENEFICIARY), AMOUNT / 2);
        assertEq(token.balanceOf(STRANGER), 0);
    }

    // ----- access control ------------------------------------------------

    function test_OnlyLaunchpad_CanCreate() public {
        token.mint(address(vault), AMOUNT);
        IStaircaseVestingVault.Step[] memory s = _quarterSteps();

        vm.prank(STRANGER);
        vm.expectRevert(StaircaseVestingVault.OnlyLaunchpad.selector);
        vault.createVest(address(token), BENEFICIARY, AMOUNT, s);

        // Even the beneficiary cannot self-create.
        vm.prank(BENEFICIARY);
        vm.expectRevert(StaircaseVestingVault.OnlyLaunchpad.selector);
        vault.createVest(address(token), BENEFICIARY, AMOUNT, s);
    }

    function test_Constructor_RejectsZeroLaunchpad() public {
        vm.expectRevert(StaircaseVestingVault.ZeroAddress.selector);
        new StaircaseVestingVault(address(0));
    }

    // ----- validation reverts --------------------------------------------

    function _createExpectRevert(
        address tok,
        address ben,
        uint256 amount,
        IStaircaseVestingVault.Step[] memory steps,
        bytes4 err
    ) internal {
        vm.prank(LAUNCHPAD);
        vm.expectRevert(err);
        vault.createVest(tok, ben, amount, steps);
    }

    function test_Revert_ZeroBeneficiary() public {
        _createExpectRevert(address(token), address(0), AMOUNT, _quarterSteps(), StaircaseVestingVault.ZeroAddress.selector);
    }

    function test_Revert_ZeroToken() public {
        _createExpectRevert(address(0), BENEFICIARY, AMOUNT, _quarterSteps(), StaircaseVestingVault.ZeroAddress.selector);
    }

    function test_Revert_ZeroAmount() public {
        _createExpectRevert(address(token), BENEFICIARY, 0, _quarterSteps(), StaircaseVestingVault.ZeroAmount.selector);
    }

    function test_Revert_EmptySteps() public {
        IStaircaseVestingVault.Step[] memory s = new IStaircaseVestingVault.Step[](0);
        _createExpectRevert(address(token), BENEFICIARY, AMOUNT, s, StaircaseVestingVault.BadStepCount.selector);
    }

    function test_Revert_TooManySteps() public {
        // 25 steps > MAX_STEPS(24). Build a strictly-increasing, valid-shaped
        // curve so BadStepCount is the FIRST thing that trips.
        IStaircaseVestingVault.Step[] memory s = new IStaircaseVestingVault.Step[](25);
        for (uint256 i = 0; i < 25; ++i) {
            uint16 bps = uint16(((i + 1) * 10000) / 25);
            if (i == 24) bps = 10000;
            s[i] = IStaircaseVestingVault.Step(t0 + uint64((i + 1) * 1 days), bps == 0 ? 1 : bps);
        }
        _createExpectRevert(address(token), BENEFICIARY, AMOUNT, s, StaircaseVestingVault.BadStepCount.selector);
    }

    function test_Revert_FirstStepNotFuture() public {
        IStaircaseVestingVault.Step[] memory s = _quarterSteps();
        s[0].unlockTime = t0; // == now, not strictly future
        _createExpectRevert(address(token), BENEFICIARY, AMOUNT, s, StaircaseVestingVault.FirstStepNotFuture.selector);
    }

    function test_Revert_NonIncreasingTime() public {
        IStaircaseVestingVault.Step[] memory s = _quarterSteps();
        s[2].unlockTime = s[1].unlockTime; // equal => not strictly increasing
        _createExpectRevert(address(token), BENEFICIARY, AMOUNT, s, StaircaseVestingVault.NonIncreasingTime.selector);
    }

    function test_Revert_NonIncreasingBps() public {
        IStaircaseVestingVault.Step[] memory s = _quarterSteps();
        s[2].cumulativeBps = s[1].cumulativeBps; // equal => not strictly increasing
        // last is still 10000, so this trips NonIncreasingBps first.
        _createExpectRevert(address(token), BENEFICIARY, AMOUNT, s, StaircaseVestingVault.NonIncreasingBps.selector);
    }

    function test_Revert_LastStepNotFull() public {
        IStaircaseVestingVault.Step[] memory s = _quarterSteps();
        s[3].cumulativeBps = 9999; // strictly increasing but not 100%
        _createExpectRevert(address(token), BENEFICIARY, AMOUNT, s, StaircaseVestingVault.LastStepNotFull.selector);
    }

    function test_Revert_ZeroBps() public {
        IStaircaseVestingVault.Step[] memory s = new IStaircaseVestingVault.Step[](2);
        s[0] = IStaircaseVestingVault.Step(t0 + 1 days, 0); // 0 not allowed
        s[1] = IStaircaseVestingVault.Step(t0 + 2 days, 10000);
        _createExpectRevert(address(token), BENEFICIARY, AMOUNT, s, StaircaseVestingVault.BpsOutOfRange.selector);
    }

    function test_Revert_BpsOverDenominator() public {
        IStaircaseVestingVault.Step[] memory s = new IStaircaseVestingVault.Step[](2);
        s[0] = IStaircaseVestingVault.Step(t0 + 1 days, 10001); // > 10000
        s[1] = IStaircaseVestingVault.Step(t0 + 2 days, 10000);
        _createExpectRevert(address(token), BENEFICIARY, AMOUNT, s, StaircaseVestingVault.BpsOutOfRange.selector);
    }

    // ----- claim on nonexistent vest -------------------------------------

    function test_Revert_ClaimNoVest() public {
        vm.expectRevert(StaircaseVestingVault.NoVest.selector);
        vault.claim(999);
    }

    // ----- getters -------------------------------------------------------

    function test_Getters() public {
        uint256 id = _createFunded(AMOUNT, _quarterSteps());
        (address tok, address ben, uint256 amount, uint256 claimed, IStaircaseVestingVault.Step[] memory steps) =
            vault.getVest(id);
        assertEq(tok, address(token));
        assertEq(ben, BENEFICIARY);
        assertEq(amount, AMOUNT);
        assertEq(claimed, 0);
        assertEq(steps.length, 4);
        assertEq(steps[0].cumulativeBps, 2500);
        assertEq(steps[3].cumulativeBps, 10000);

        assertEq(vault.getSteps(id).length, 4);
    }

    function test_Events() public {
        token.mint(address(vault), AMOUNT);
        vm.expectEmit(true, true, true, true);
        emit StaircaseVestingVault.VestCreated(1, address(token), BENEFICIARY, AMOUNT);
        vm.prank(LAUNCHPAD);
        uint256 id = vault.createVest(address(token), BENEFICIARY, AMOUNT, _quarterSteps());

        vm.warp(t0 + 1 days);
        vm.expectEmit(true, true, false, true);
        emit StaircaseVestingVault.Claimed(id, BENEFICIARY, AMOUNT / 4);
        vault.claim(id);
    }

    // ----- reentrancy ----------------------------------------------------

    function test_Reentrancy_ClaimGuarded() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(address(vault), AMOUNT);

        IStaircaseVestingVault.Step[] memory s = new IStaircaseVestingVault.Step[](1);
        s[0] = IStaircaseVestingVault.Step(t0 + 1 days, 10000);
        vm.prank(LAUNCHPAD);
        uint256 id = vault.createVest(address(evil), BENEFICIARY, AMOUNT, s);

        evil.arm(vault, id);
        vm.warp(t0 + 1 days);

        // The re-entrant claim inside transfer must revert the whole call.
        vm.expectRevert(); // ReentrancyGuardReentrantCall
        vault.claim(id);

        // State untouched: nothing paid out.
        assertEq(evil.balanceOf(BENEFICIARY), 0);
        assertEq(vault.claimable(id), AMOUNT);
    }
}
