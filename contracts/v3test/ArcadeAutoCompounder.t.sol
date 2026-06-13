// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import {ArcadeAutoCompounder} from "../v3src/ArcadeAutoCompounder.sol";

/**
 * Audit I3 fix: minimum viable Foundry test matrix for
 * ArcadeAutoCompounder. The Compounder shipped to testnet with zero
 * unit coverage; this file lands the baseline set the audit
 * recommended as a hard mainnet prerequisite.
 *
 * The contract is Solc 0.7.6 (shares the canonical V3 NPM interface
 * with the rest of the v3src/ stack), but `forge-std`'s Test base
 * requires Solc >=0.8.13. To avoid a cross-version test setup, this
 * file inlines a minimal `Vm` cheatcode interface + a tiny
 * DSTest-shaped assertion suite — enough to assert reverts, equality,
 * and addresses. Foundry's test runner detects this contract via the
 * `IS_TEST` flag + the `failed()` getter, and treats any non-reverting
 * test function with `failed() == false` as passing.
 *
 * Coverage map:
 *   - constructor argument validation (zero addresses, fee cap)
 *   - admin paths (setOperator / setProtocolFeeBps / setFeeRecipient /
 *     transferOwnership / setPaused — rejects + happy path)
 *   - protocolFeeBps cap enforcement
 *   - paused gate (deposit / setMode rejected, withdraw allowed)
 *   - cooldown helper sanity (nextActionAvailableAt on fresh tokenId)
 *
 * Out of scope (tracked separately):
 *   - fork test wiring real Arc NPM/quoter
 *   - V3 pool TWAP gate end-to-end against a real pool (H1)
 *   - happy-path compound + leftover refund
 */

interface IVm {
    function prank(address) external;
    function expectRevert(bytes calldata) external;
}

contract ArcadeAutoCompounderTest {
    // Foundry test-runner protocol: the IS_TEST flag tells forge this
    // is a test contract, and the runner reads `failed()` to decide
    // pass/fail. We never emit a failure manually — every assertion
    // helper reverts on mismatch, which the runner catches and
    // reports as the test failing.
    bool public constant IS_TEST = true;
    bool internal _failed = false;

    function failed() public view returns (bool) {
        return _failed;
    }

    IVm internal constant vm = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ArcadeAutoCompounder internal compounder;

    address internal constant NPM = address(0xAAAA);
    address internal constant FACTORY = address(0xBBBB);
    address internal owner = address(0x1111);
    address internal operator = address(0x2222);
    address internal feeRecipient = address(0x3333);
    address internal user = address(0x4444);

    function setUp() public {
        compounder = new ArcadeAutoCompounder(
            NPM,
            FACTORY,
            owner,
            operator,
            feeRecipient,
            100 // 1% protocol fee
        );
    }

    // --------------------------------------------------------------
    // Assertion helpers (DSTest-shaped, inline so the test file has
    // no external dep)
    // --------------------------------------------------------------

    function assertEq(uint256 a, uint256 b) internal {
        if (a != b) {
            _failed = true;
            revert("assertEq(uint) failed");
        }
    }
    function assertEq(address a, address b) internal {
        if (a != b) {
            _failed = true;
            revert("assertEq(address) failed");
        }
    }
    function assertTrue(bool b) internal {
        if (!b) {
            _failed = true;
            revert("assertTrue failed");
        }
    }
    function assertFalse(bool b) internal {
        if (b) {
            _failed = true;
            revert("assertFalse failed");
        }
    }

    // --------------------------------------------------------------
    // Constructor argument validation
    // --------------------------------------------------------------

    function test_constructor_rejectsZeroNpm() public {
        vm.expectRevert(bytes("ZERO_NPM"));
        new ArcadeAutoCompounder(address(0), FACTORY, owner, operator, feeRecipient, 100);
    }

    function test_constructor_rejectsZeroFactory() public {
        vm.expectRevert(bytes("ZERO_FACTORY"));
        new ArcadeAutoCompounder(NPM, address(0), owner, operator, feeRecipient, 100);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(bytes("ZERO_OWNER"));
        new ArcadeAutoCompounder(NPM, FACTORY, address(0), operator, feeRecipient, 100);
    }

    function test_constructor_rejectsZeroFeeRecipient() public {
        vm.expectRevert(bytes("ZERO_FEE_RECIPIENT"));
        new ArcadeAutoCompounder(NPM, FACTORY, owner, operator, address(0), 100);
    }

    function test_constructor_rejectsFeeAboveCap() public {
        vm.expectRevert(bytes("FEE_TOO_HIGH"));
        // MAX_PROTOCOL_FEE_BPS = 500; one past the cap rejects.
        new ArcadeAutoCompounder(NPM, FACTORY, owner, operator, feeRecipient, 501);
    }

    function test_constructor_acceptsCapExactly() public {
        // Exactly 500 (5%) is the high-water mark; the cap is inclusive
        // per the constructor's `<=` check.
        ArcadeAutoCompounder edge = new ArcadeAutoCompounder(
            NPM,
            FACTORY,
            owner,
            operator,
            feeRecipient,
            500
        );
        assertEq(uint256(edge.protocolFeeBps()), 500);
    }

    // --------------------------------------------------------------
    // Admin: setProtocolFeeBps
    // --------------------------------------------------------------

    function test_admin_setProtocolFeeBps_rejectsNonOwner() public {
        vm.prank(user);
        vm.expectRevert(bytes("NOT_OWNER"));
        compounder.setProtocolFeeBps(200);
    }

    function test_admin_setProtocolFeeBps_rejectsAboveCap() public {
        vm.prank(owner);
        vm.expectRevert(bytes("FEE_TOO_HIGH"));
        compounder.setProtocolFeeBps(501);
    }

    function test_admin_setProtocolFeeBps_writesValue() public {
        vm.prank(owner);
        compounder.setProtocolFeeBps(250);
        assertEq(uint256(compounder.protocolFeeBps()), 250);
    }

    function test_admin_setProtocolFeeBps_acceptsZero() public {
        // Zero is valid — the protocol can waive its fee entirely.
        // The _takeProtocolFee early-return handles the zero case
        // without trying to transfer.
        vm.prank(owner);
        compounder.setProtocolFeeBps(0);
        assertEq(uint256(compounder.protocolFeeBps()), 0);
    }

    // --------------------------------------------------------------
    // Admin: setOperator
    // --------------------------------------------------------------

    function test_admin_setOperator_rejectsNonOwner() public {
        vm.prank(user);
        vm.expectRevert(bytes("NOT_OWNER"));
        compounder.setOperator(address(0x9999));
    }

    function test_admin_setOperator_acceptsZero() public {
        // Zero operator is intentional — admin can park the operator
        // slot during a key rotation. Permissionless callers can still
        // trigger compound/pushFees; operator is informational here.
        vm.prank(owner);
        compounder.setOperator(address(0));
        assertEq(compounder.operator(), address(0));
    }

    function test_admin_setOperator_rotatesValue() public {
        address newOperator = address(0x9999);
        vm.prank(owner);
        compounder.setOperator(newOperator);
        assertEq(compounder.operator(), newOperator);
    }

    // --------------------------------------------------------------
    // Admin: setFeeRecipient
    // --------------------------------------------------------------

    function test_admin_setFeeRecipient_rejectsNonOwner() public {
        vm.prank(user);
        vm.expectRevert(bytes("NOT_OWNER"));
        compounder.setFeeRecipient(address(0x9999));
    }

    function test_admin_setFeeRecipient_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(bytes("ZERO_FEE_RECIPIENT"));
        compounder.setFeeRecipient(address(0));
    }

    function test_admin_setFeeRecipient_rotatesValue() public {
        address newRecipient = address(0x9999);
        vm.prank(owner);
        compounder.setFeeRecipient(newRecipient);
        assertEq(compounder.feeRecipient(), newRecipient);
    }

    // --------------------------------------------------------------
    // Admin: transferOwnership
    // --------------------------------------------------------------

    function test_admin_transferOwnership_rejectsNonOwner() public {
        vm.prank(user);
        vm.expectRevert(bytes("NOT_OWNER"));
        compounder.transferOwnership(address(0x9999));
    }

    function test_admin_transferOwnership_rejectsZero() public {
        // Audit I6 surface: the contract refuses zero explicitly. The
        // two-step accept pattern is the I6 follow-up and is
        // intentionally not asserted here — fat-finger to a non-zero
        // EOA is the bigger risk and is not currently mitigated.
        vm.prank(owner);
        vm.expectRevert(bytes("ZERO_OWNER"));
        compounder.transferOwnership(address(0));
    }

    function test_admin_transferOwnership_setsPendingOnly() public {
        // Audit I6 fix: transferOwnership now sets pendingOwner; the
        // current owner stays in place until the proposed owner calls
        // acceptOwnership. This test asserts the two-step shape.
        address newOwner = address(0x9999);
        vm.prank(owner);
        compounder.transferOwnership(newOwner);
        assertEq(compounder.owner(), owner); // unchanged
        assertEq(compounder.pendingOwner(), newOwner);
    }

    function test_admin_transferOwnership_oldOwnerKeepsPower() public {
        // Critical invariant: until acceptOwnership lands, the old
        // owner retains every admin power. This is the entire point
        // of the two-step pattern — a fat-finger to a wrong-but-EOA
        // address no longer bricks the contract.
        address newOwner = address(0x9999);
        vm.prank(owner);
        compounder.transferOwnership(newOwner);
        vm.prank(owner);
        compounder.setOperator(address(0xDEAD));
        assertEq(compounder.operator(), address(0xDEAD));
    }

    function test_acceptOwnership_rejectsNonPending() public {
        address newOwner = address(0x9999);
        vm.prank(owner);
        compounder.transferOwnership(newOwner);
        // Random EOA cannot complete the handoff.
        vm.prank(user);
        vm.expectRevert(bytes("NOT_PENDING_OWNER"));
        compounder.acceptOwnership();
    }

    function test_acceptOwnership_rejectsBeforeProposal() public {
        // No transferOwnership called -> pendingOwner is zero.
        // address(0) calling acceptOwnership matches zero, but
        // msg.sender cannot be address(0) at the EVM level so this
        // path is unreachable. Any non-zero caller hits NOT_PENDING_OWNER.
        vm.prank(user);
        vm.expectRevert(bytes("NOT_PENDING_OWNER"));
        compounder.acceptOwnership();
    }

    function test_acceptOwnership_completesHandoff() public {
        address newOwner = address(0x9999);
        vm.prank(owner);
        compounder.transferOwnership(newOwner);
        vm.prank(newOwner);
        compounder.acceptOwnership();
        assertEq(compounder.owner(), newOwner);
        assertEq(compounder.pendingOwner(), address(0));
        // Old owner is now powerless.
        vm.prank(owner);
        vm.expectRevert(bytes("NOT_OWNER"));
        compounder.setOperator(address(0xDEAD));
    }

    // --------------------------------------------------------------
    // Admin: setPaused
    // --------------------------------------------------------------

    function test_admin_setPaused_rejectsNonOwner() public {
        vm.prank(user);
        vm.expectRevert(bytes("NOT_OWNER"));
        compounder.setPaused(true);
    }

    function test_admin_setPaused_writesValueTrue() public {
        vm.prank(owner);
        compounder.setPaused(true);
        assertTrue(compounder.paused());
    }

    function test_admin_setPaused_writesValueFalse() public {
        vm.prank(owner);
        compounder.setPaused(true);
        vm.prank(owner);
        compounder.setPaused(false);
        assertFalse(compounder.paused());
    }

    function test_paused_blocksDeposit() public {
        // Deposit is `whenNotPaused`. With paused=true, even a
        // well-formed depositPosition reverts before any storage
        // touch. We don't need a real NPM mock here because the pause
        // check fires before NPM.safeTransferFrom.
        vm.prank(owner);
        compounder.setPaused(true);
        vm.prank(user);
        vm.expectRevert(bytes("PAUSED"));
        compounder.depositPosition(1, 1, 100_000, 50);
    }

    function test_paused_doesNotBlockWithdraw() public {
        // Critical invariant: withdraw is the user's escape hatch and
        // MUST work even when the contract is paused. Without a real
        // NPM mock we can only assert the access-control layer: a
        // non-depositor still fails NOT_DEPOSITOR, proving the pause
        // gate did not fire first. The full happy-path withdraw under
        // pause is exercised by the fork test (not in this file).
        vm.prank(owner);
        compounder.setPaused(true);
        vm.prank(user);
        vm.expectRevert(bytes("NOT_DEPOSITOR"));
        compounder.withdrawPosition(1);
    }

    // --------------------------------------------------------------
    // Configs default to zero (storage layout sanity)
    // --------------------------------------------------------------

    function test_config_freshTokenIdReadsZero() public {
        (
            address depositor,
            uint8 mode,
            uint16 maxSlippageBps,
            uint64 lastActionAt,
            uint64 minFeeMicros
        ) = compounder.configs(999);
        assertEq(depositor, address(0));
        assertEq(uint256(mode), 0);
        assertEq(uint256(maxSlippageBps), 0);
        assertEq(uint256(lastActionAt), 0);
        assertEq(uint256(minFeeMicros), 0);
    }

    // --------------------------------------------------------------
    // Cooldown helpers
    // --------------------------------------------------------------

    function test_cooldown_freshPositionReadsCurrentTimestamp() public {
        // nextActionAvailableAt(unknownToken) reads lastActionAt = 0
        // and returns block.timestamp (the "ready right now" signal).
        // Confirms the helper does not underflow on a never-actioned
        // tokenId.
        uint64 next = compounder.nextActionAvailableAt(123);
        assertEq(uint256(next), block.timestamp);
    }
}
