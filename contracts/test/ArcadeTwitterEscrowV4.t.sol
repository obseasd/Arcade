// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ArcadeTwitterEscrowV4} from "../src/launchpad/ArcadeTwitterEscrowV4.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// A token that reverts on transfer to a specific blocked address, to exercise
/// the forfeit pull-payment fallback.
contract BlockingUSDC is ERC20 {
    address public blocked;
    constructor() ERC20("Blocking USDC", "bUSDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(address a) external { blocked = a; }
    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked, "blocked");
        super._update(from, to, value);
    }
}

contract ArcadeTwitterEscrowV4Test is Test {
    ArcadeTwitterEscrowV4 escrow;
    MockUSDC usdc;

    address constant OWNER = address(0xDEAD);
    address constant HOOK = address(0x400C); // the allowlisted crediter
    address constant USER = address(0xC0DE); // the @handle owner's wallet
    uint256 signerPk;
    address signer;

    uint256 constant POS = 42;
    uint256 constant SLOT = 0;

    bytes32 constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 positionId,uint256 slotIndex,address recipient,address token,uint256 amount,uint256 deadline,bytes32 nonce)"
    );

    function setUp() public {
        signerPk = uint256(keccak256("signer-key"));
        signer = vm.addr(signerPk);
        usdc = new MockUSDC();
        escrow = new ArcadeTwitterEscrowV4(signer, OWNER);
        vm.prank(OWNER);
        escrow.setCrediter(HOOK, true);
    }

    // ============ helpers ============

    /// Simulate the hook transferring USDC to the escrow then crediting.
    function _credit(uint256 amount) internal {
        usdc.mint(address(escrow), amount);
        vm.prank(HOOK);
        escrow.creditSlot(POS, SLOT, address(usdc), amount);
    }

    function _sign(address recipient_, address token, uint256 amount, uint256 deadline, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(CLAIM_TYPEHASH, POS, SLOT, recipient_, token, amount, deadline, nonce));
        bytes32 digest = MessageHashUtils.toTypedDataHash(escrow.DOMAIN_SEPARATOR(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _authorizeAndClaim(address recipient_, uint256 signedAmount, bytes32 nonce) internal {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(recipient_, address(usdc), signedAmount, deadline, nonce);
        vm.prank(recipient_);
        escrow.authorize(POS, SLOT, recipient_, address(usdc), signedAmount, deadline, nonce, sig);
        vm.warp(block.timestamp + escrow.claimTimelock() + 1);
        escrow.claimByTwitter(nonce);
    }

    // ============ creditSlot ============

    function test_creditSlot_onlyAllowlistedCrediter() public {
        usdc.mint(address(escrow), 100e6);
        vm.expectRevert(ArcadeTwitterEscrowV4.NotCrediter.selector);
        escrow.creditSlot(POS, SLOT, address(usdc), 100e6); // not allowlisted
    }

    function test_creditSlot_balanceDiff_rejectsUndeliveredCredit() public {
        // No USDC transferred to the escrow -> free == 0 -> crediting reverts,
        // so a credit whose transfer pended can't inflate the books.
        vm.prank(HOOK);
        vm.expectRevert(ArcadeTwitterEscrowV4.NothingDelivered.selector);
        escrow.creditSlot(POS, SLOT, address(usdc), 100e6);
    }

    function test_creditSlot_balanceDiff_rejectsOverCredit() public {
        usdc.mint(address(escrow), 100e6); // only 100 delivered
        vm.prank(HOOK);
        vm.expectRevert(ArcadeTwitterEscrowV4.NothingDelivered.selector);
        escrow.creditSlot(POS, SLOT, address(usdc), 150e6); // claims 150 > 100
    }

    function test_creditSlot_pinsToken_rejectsSecondToken() public {
        _credit(100e6);
        MockUSDC other = new MockUSDC();
        other.mint(address(escrow), 50e6);
        vm.prank(HOOK);
        vm.expectRevert(ArcadeTwitterEscrowV4.InvalidToken.selector);
        escrow.creditSlot(POS, SLOT, address(other), 50e6);
    }

    function test_creditSlot_accumulates() public {
        _credit(100e6);
        _credit(50e6);
        assertEq(escrow.balances(POS, SLOT, address(usdc)), 150e6, "accumulated");
        assertEq(escrow.creditedTotal(address(usdc)), 150e6, "total");
    }

    // ============ authorize + claim ============

    function test_claim_happyPath_sweepsToRecipient() public {
        _credit(100e6);
        _authorizeAndClaim(USER, 100e6, keccak256("n1"));
        assertEq(usdc.balanceOf(USER), 100e6, "recipient got fees");
        assertEq(escrow.balances(POS, SLOT, address(usdc)), 0, "slot swept");
        assertEq(escrow.creditedTotal(address(usdc)), 0, "total cleared");
    }

    function test_claim_sweepsFullBalance_notJustSignedAmount() public {
        _credit(100e6);
        // Backend signs for 60 (minimum guarantee), but 100 is credited ->
        // claim sweeps the full 100 so nothing strands.
        _authorizeAndClaim(USER, 60e6, keccak256("n1"));
        assertEq(usdc.balanceOf(USER), 100e6, "swept full balance");
    }

    function test_authorize_recipientMustBeSender() public {
        _credit(100e6);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _sign(USER, address(usdc), 100e6, deadline, nonce);
        // Attacker submits with recipient=USER but from their own wallet.
        vm.prank(address(0xBAD));
        vm.expectRevert(ArcadeTwitterEscrowV4.RecipientNotSender.selector);
        escrow.authorize(POS, SLOT, USER, address(usdc), 100e6, deadline, nonce, sig);
    }

    function test_authorize_badSignatureReverts() public {
        _credit(100e6);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 nonce = keccak256("n1");
        // Sign with the wrong key.
        bytes32 structHash =
            keccak256(abi.encode(CLAIM_TYPEHASH, POS, SLOT, USER, address(usdc), uint256(100e6), deadline, nonce));
        bytes32 digest = MessageHashUtils.toTypedDataHash(escrow.DOMAIN_SEPARATOR(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256("wrong")), digest);
        vm.prank(USER);
        vm.expectRevert(ArcadeTwitterEscrowV4.InvalidSignature.selector);
        escrow.authorize(POS, SLOT, USER, address(usdc), 100e6, deadline, nonce, abi.encodePacked(r, s, v));
    }

    function test_authorize_nonceReplayReverts() public {
        _credit(100e6);
        _authorizeAndClaim(USER, 100e6, keccak256("n1"));
        _credit(50e6);
        // Reusing the same nonce must revert.
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sign(USER, address(usdc), 50e6, deadline, keccak256("n1"));
        vm.prank(USER);
        vm.expectRevert(ArcadeTwitterEscrowV4.NonceReused.selector);
        escrow.authorize(POS, SLOT, USER, address(usdc), 50e6, deadline, keccak256("n1"), sig);
    }

    function test_claim_timelockEnforced() public {
        vm.prank(OWNER);
        escrow.setClaimTimelock(1 hours);
        _credit(100e6);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _sign(USER, address(usdc), 100e6, deadline, nonce);
        vm.prank(USER);
        escrow.authorize(POS, SLOT, USER, address(usdc), 100e6, deadline, nonce, sig);
        // Too early.
        vm.expectRevert(ArcadeTwitterEscrowV4.Timelocked.selector);
        escrow.claimByTwitter(nonce);
        // After the timelock.
        vm.warp(block.timestamp + 1 hours + 1);
        escrow.claimByTwitter(nonce);
        assertEq(usdc.balanceOf(USER), 100e6, "claimed after timelock");
    }

    function test_veto_cancelsPendingClaim() public {
        vm.prank(OWNER);
        escrow.setClaimTimelock(1 hours);
        _credit(100e6);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _sign(USER, address(usdc), 100e6, deadline, nonce);
        vm.prank(USER);
        escrow.authorize(POS, SLOT, USER, address(usdc), 100e6, deadline, nonce, sig);
        vm.prank(OWNER);
        escrow.veto(nonce);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(ArcadeTwitterEscrowV4.AlreadyClaimed.selector);
        escrow.claimByTwitter(nonce);
        // The slot reopened so a fresh nonce can claim.
        _authorizeAndClaim(USER, 100e6, keccak256("n2"));
        assertEq(usdc.balanceOf(USER), 100e6, "re-authorized after veto");
    }

    // ============ REPEATABLE claims (the periodic model) ============

    function test_claim_repeatable_acrossPeriods() public {
        _credit(100e6);
        _authorizeAndClaim(USER, 100e6, keccak256("p1"));
        assertEq(usdc.balanceOf(USER), 100e6, "period 1");
        // More fees accrue after the first claim -> claimable again.
        _credit(70e6);
        _authorizeAndClaim(USER, 70e6, keccak256("p2"));
        assertEq(usdc.balanceOf(USER), 170e6, "period 2 accrued + claimed");
        assertEq(escrow.balances(POS, SLOT, address(usdc)), 0, "slot clean");
    }

    // ============ rescue (bounded) ============

    function test_rescue_cannotTouchCreditedBalance() public {
        _credit(100e6);
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV4.ExceedsFreeBalance.selector);
        escrow.rescue(address(usdc), OWNER, 1);
    }

    function test_rescue_sweepsUnearmarkedOnly() public {
        _credit(100e6);
        usdc.mint(address(escrow), 30e6); // stray transfer, not credited
        vm.prank(OWNER);
        escrow.rescue(address(usdc), OWNER, 30e6);
        assertEq(usdc.balanceOf(OWNER), 30e6, "swept only the stray");
        assertEq(escrow.balances(POS, SLOT, address(usdc)), 100e6, "credited intact");
    }

    // ============ forfeit ============

    function test_forfeit_afterDelay_routesStrandedBalance() public {
        _credit(100e6);
        vm.expectRevert(ArcadeTwitterEscrowV4.NotStaleYet.selector);
        vm.prank(OWNER);
        escrow.forfeitStaleClaim(POS, SLOT, OWNER);

        vm.warp(block.timestamp + escrow.FORFEIT_DELAY() + 1);
        vm.prank(OWNER);
        escrow.forfeitStaleClaim(POS, SLOT, OWNER);
        assertEq(usdc.balanceOf(OWNER), 100e6, "forfeited to owner-chosen addr");
        assertEq(escrow.balances(POS, SLOT, address(usdc)), 0, "slot cleared");
    }

    function test_forfeit_transferRevert_stashesPullPayment() public {
        BlockingUSDC bad = new BlockingUSDC();
        bad.mint(address(escrow), 100e6);
        vm.prank(HOOK);
        escrow.creditSlot(POS, SLOT, address(bad), 100e6);
        bad.setBlocked(USER);
        vm.warp(block.timestamp + escrow.FORFEIT_DELAY() + 1);
        vm.prank(OWNER);
        escrow.forfeitStaleClaim(POS, SLOT, USER); // transfer to USER reverts -> pull ledger
        assertEq(escrow.pendingForfeit(address(bad), USER), 100e6, "stashed");
        // Unblock and recover.
        bad.setBlocked(address(0));
        vm.prank(USER);
        escrow.withdrawForfeitFailure(address(bad));
        assertEq(bad.balanceOf(USER), 100e6, "recovered via pull");
    }

    function test_rescue_cannotTouchPendingForfeit() public {
        // A forfeit whose transfer reverts stashes to the pull-payment ledger.
        // Those tokens are still owed to the recipient, so rescue must exclude
        // them (audit LOW-1).
        BlockingUSDC bad = new BlockingUSDC();
        bad.mint(address(escrow), 100e6);
        vm.prank(HOOK);
        escrow.creditSlot(POS, SLOT, address(bad), 100e6);
        bad.setBlocked(USER);
        vm.warp(block.timestamp + escrow.FORFEIT_DELAY() + 1);
        vm.prank(OWNER);
        escrow.forfeitStaleClaim(POS, SLOT, USER); // stashes to pendingForfeit

        // The 100e6 is now earmarked for USER's pull; rescue sees 0 free.
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV4.ExceedsFreeBalance.selector);
        escrow.rescue(address(bad), OWNER, 1);
    }

    // ============ signer rotation (two-step) ============

    function test_signerRotation_twoStepWithDelay() public {
        uint256 newPk = uint256(keccak256("new-signer"));
        address newSigner = vm.addr(newPk);
        vm.prank(OWNER);
        escrow.startSignerRotation(newSigner);
        // Cannot finalize before the delay.
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV4.RotationNotReady.selector);
        escrow.finalizeSignerRotation();
        // After the delay.
        vm.warp(block.timestamp + escrow.SIGNER_ROTATION_DELAY() + 1);
        vm.prank(OWNER);
        escrow.finalizeSignerRotation();
        assertEq(escrow.trustedSigner(), newSigner, "signer rotated");
        // A claim signed by the NEW signer now works.
        _credit(100e6);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 nonce = keccak256("n1");
        bytes32 structHash =
            keccak256(abi.encode(CLAIM_TYPEHASH, POS, SLOT, USER, address(usdc), uint256(100e6), deadline, nonce));
        bytes32 digest = MessageHashUtils.toTypedDataHash(escrow.DOMAIN_SEPARATOR(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newPk, digest);
        vm.prank(USER);
        escrow.authorize(POS, SLOT, USER, address(usdc), 100e6, deadline, nonce, abi.encodePacked(r, s, v));
        escrow.claimByTwitter(nonce);
        assertEq(usdc.balanceOf(USER), 100e6, "new signer authorized a claim");
    }

    function test_renounceOwnership_disabled() public {
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV4.RenounceDisabled.selector);
        escrow.renounceOwnership();
    }
}
