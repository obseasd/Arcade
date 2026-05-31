// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ArcadeTwitterEscrowV3} from "../src/launchpad/ArcadeTwitterEscrowV3.sol";

/// @notice Records rotation calls and supports configurable revert behavior so
///         we can exercise the try/catch path in claimByTwitter.
contract MockLocker {
    bool public shouldRevertRecipient;
    bool public shouldRevertAdmin;
    uint256 public lastPositionId;
    uint256 public lastSlotIndex;
    address public lastRecipient;
    address public lastAdmin;

    function setRevertRecipient(bool v) external { shouldRevertRecipient = v; }
    function setRevertAdmin(bool v) external { shouldRevertAdmin = v; }

    function updateRecipient(uint256 positionId, uint256 index, address newRecipient) external {
        if (shouldRevertRecipient) revert("recipient rotation failed");
        lastPositionId = positionId;
        lastSlotIndex = index;
        lastRecipient = newRecipient;
    }

    function updateAdmin(uint256 positionId, uint256 index, address newAdmin) external {
        if (shouldRevertAdmin) revert("admin rotation failed");
        lastPositionId = positionId;
        lastSlotIndex = index;
        lastAdmin = newAdmin;
    }
}

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract MockClanker is ERC20 {
    constructor() ERC20("Clanker", "CLNK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract ArcadeTwitterEscrowV3Test is Test {
    ArcadeTwitterEscrowV3 escrow;
    MockLocker locker;
    MockUSDC usdc;
    MockClanker clanker;

    address constant OWNER = address(0xDEAD);
    address constant USER = address(0xC0DE);
    uint256 signerPk;
    address signer;
    address recipient;

    bytes32 constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 positionId,uint256 slotIndex,address recipient,address pairedToken,uint256 pairedAmount,address clankerToken,uint256 clankerAmount,uint256 deadline,bytes32 nonce)"
    );

    function setUp() public {
        signerPk = uint256(keccak256("signer-key"));
        signer = vm.addr(signerPk);
        recipient = USER;

        locker = new MockLocker();
        usdc = new MockUSDC();
        clanker = new MockClanker();

        // V3 escrow's LOCKER is settable-once. Production flow: deploy
        // escrow, deploy locker pointing to escrow address, then setLocker.
        escrow = new ArcadeTwitterEscrowV3(signer, OWNER);
        vm.prank(OWNER);
        escrow.setLocker(address(locker));
    }

    // ============= helpers =================

    function _credit(uint256 positionId, uint256 slot, address token, uint256 amount) internal {
        // Pretend tokens already arrived in the escrow (by minting directly to it).
        if (token == address(usdc)) usdc.mint(address(escrow), amount);
        else if (token == address(clanker)) clanker.mint(address(escrow), amount);
        vm.prank(address(locker));
        escrow.creditSlot(positionId, slot, token, amount);
    }

    function _signClaim(
        uint256 positionId,
        uint256 slotIndex,
        address recipient_,
        address pairedToken,
        uint256 pairedAmount,
        address clankerToken,
        uint256 clankerAmount,
        uint256 deadline,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH, positionId, slotIndex, recipient_,
                pairedToken, pairedAmount, clankerToken, clankerAmount, deadline, nonce
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(escrow.DOMAIN_SEPARATOR(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ============= setLocker one-shot =================

    function test_setLocker_revertsOnSecondCall() public {
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.LockerAlreadySet.selector);
        escrow.setLocker(address(0xDEAD));
    }

    function test_setLocker_revertsOnNonOwner() public {
        ArcadeTwitterEscrowV3 fresh = new ArcadeTwitterEscrowV3(signer, OWNER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fresh.setLocker(address(0xDEAD));
    }

    function test_setLocker_revertsOnZero() public {
        ArcadeTwitterEscrowV3 fresh = new ArcadeTwitterEscrowV3(signer, OWNER);
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.ZeroAddress.selector);
        fresh.setLocker(address(0));
    }

    function test_creditSlot_revertsBeforeSetLocker() public {
        ArcadeTwitterEscrowV3 fresh = new ArcadeTwitterEscrowV3(signer, OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.LockerNotSet.selector);
        fresh.creditSlot(1, 0, address(usdc), 100);
    }

    // ============= F-3: per-slot accounting =================

    function test_F3_creditSlot_onlyLocker() public {
        vm.expectRevert(ArcadeTwitterEscrowV3.NotLocker.selector);
        escrow.creditSlot(1, 0, address(usdc), 100);
    }

    function test_F3_creditSlot_accumulates() public {
        _credit(1, 0, address(usdc), 100);
        _credit(1, 0, address(usdc), 50);
        assertEq(escrow.balances(1, 0, address(usdc)), 150);
        assertEq(escrow.creditedTotal(address(usdc)), 150);
    }

    function test_F3_authorize_revertsOnOverAttestation() public {
        _credit(1, 0, address(usdc), 100);
        // Backend signs for 200 USDC but only 100 credited -> revert.
        bytes32 nonce = bytes32("nonce-1");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 200, address(0), 0, deadline, nonce);
        vm.expectRevert(ArcadeTwitterEscrowV3.InsufficientBalance.selector);
        escrow.authorize(1, 0, recipient, address(usdc), 200, address(0), 0, deadline, nonce, sig);
    }

    function test_F3_authorize_succeedsWhenCredited() public {
        _credit(1, 0, address(usdc), 100);
        bytes32 nonce = bytes32("ok-1");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        // Pending claim was recorded.
        // PendingClaim layout: (recipient, pairedToken, pairedAmount,
        // clankerToken, clankerAmount, positionId, slotIndex, executeAfter,
        // deadline, consumed, vetoed).
        (address rec,, uint256 amt,,,,,,,,) = escrow.pendingClaims(nonce);
        assertEq(rec, recipient);
        assertEq(amt, 100);
    }

    function test_F3_claim_debitsBalances() public {
        _credit(1, 0, address(usdc), 100);
        bytes32 nonce = bytes32("debit");
        // Deadline must outlast the default 1h timelock (H-01) and the warp below.
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        vm.warp(block.timestamp + escrow.claimTimelock() + 1);
        escrow.claimByTwitter(nonce);
        assertEq(escrow.balances(1, 0, address(usdc)), 0, "balance debited");
        assertEq(escrow.creditedTotal(address(usdc)), 0, "credited total debited");
        assertEq(usdc.balanceOf(recipient), 100, "recipient paid");
    }

    // ============= F-2: pause + setTrustedSigner =================

    function test_F2_pause_blocksAuthorize() public {
        _credit(1, 0, address(usdc), 100);
        vm.prank(OWNER);
        escrow.pause();
        bytes32 nonce = bytes32("paused");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
    }

    function test_F2_pause_blocksClaimByTwitter() public {
        _credit(1, 0, address(usdc), 100);
        bytes32 nonce = bytes32("blocked");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        vm.prank(OWNER);
        escrow.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.claimByTwitter(nonce);
    }

    function test_F2_pause_doesNotBlockVetoOrCreditSlot() public {
        _credit(1, 0, address(usdc), 100);
        bytes32 nonce = bytes32("veto-while-paused");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        vm.prank(OWNER);
        escrow.pause();
        // Veto still works.
        vm.prank(OWNER);
        escrow.veto(nonce);
        // CreditSlot still works (locker keeps routing).
        _credit(1, 1, address(usdc), 50);
        assertEq(escrow.balances(1, 1, address(usdc)), 50);
    }

    function test_F2_setTrustedSigner_rotatesAuth() public {
        // Old signer's sig is now invalid; new signer's sig works.
        uint256 newPk = uint256(keccak256("new-key"));
        address newSigner = vm.addr(newPk);
        vm.prank(OWNER);
        escrow.setTrustedSigner(newSigner);

        _credit(1, 0, address(usdc), 100);
        bytes32 nonce = bytes32("rotated");
        uint256 deadline = block.timestamp + 1 hours;

        // Old signer's sig is rejected.
        bytes memory oldSig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        vm.expectRevert(ArcadeTwitterEscrowV3.InvalidSignature.selector);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, oldSig);

        // New signer's sig works.
        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, uint256(1), uint256(0), recipient,
                address(usdc), uint256(100), address(0), uint256(0), deadline, nonce)
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(escrow.DOMAIN_SEPARATOR(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newPk, digest);
        bytes memory newSig = abi.encodePacked(r, s, v);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, newSig);
    }

    function test_F2_pause_unpause_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        escrow.pause();

        vm.prank(OWNER);
        escrow.pause();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        escrow.unpause();

        vm.prank(OWNER);
        escrow.unpause();
    }

    function test_F2_setTrustedSigner_rejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.ZeroAddress.selector);
        escrow.setTrustedSigner(address(0));
    }

    // ============= F-4: bounded rescue =================

    function test_F4_rescue_refusesEarmarkedBalance() public {
        // Credit 100 USDC. Then try to rescue 50 -> reverts (free = 0).
        _credit(1, 0, address(usdc), 100);
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.ExceedsFreeBalance.selector);
        escrow.rescue(address(usdc), OWNER, 50);
    }

    function test_F4_rescue_canSweepUnattributedTokens() public {
        // Mint 100 USDC directly (no creditSlot) -> rescue can sweep.
        usdc.mint(address(escrow), 100);
        vm.prank(OWNER);
        escrow.rescue(address(usdc), OWNER, 100);
        assertEq(usdc.balanceOf(OWNER), 100);
    }

    function test_F4_rescue_canSweepExcess() public {
        // Credit 100, mint 50 extra -> rescue can take only the 50 excess.
        _credit(1, 0, address(usdc), 100);
        usdc.mint(address(escrow), 50);
        vm.prank(OWNER);
        escrow.rescue(address(usdc), OWNER, 50);
        assertEq(usdc.balanceOf(OWNER), 50);
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.ExceedsFreeBalance.selector);
        escrow.rescue(address(usdc), OWNER, 1);
    }

    // ============= F-5: Ownable2Step =================

    function test_F5_transferOwnership_isTwoStep() public {
        address newOwner = address(0xB0B);

        vm.prank(OWNER);
        escrow.transferOwnership(newOwner);

        // Old owner still owns until accept.
        assertEq(escrow.owner(), OWNER);
        assertEq(escrow.pendingOwner(), newOwner);

        // Random caller cannot accept.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        escrow.acceptOwnership();

        // Pending owner accepts -> swap completes.
        vm.prank(newOwner);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), newOwner);
    }

    // ============= F-6: try/catch on locker rotation =================

    function test_F6_claim_succeedsWhenRecipientRotationReverts() public {
        _credit(1, 0, address(usdc), 100);
        locker.setRevertRecipient(true);

        bytes32 nonce = bytes32("rotrev1");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        vm.warp(block.timestamp + escrow.claimTimelock() + 1);
        // claim should NOT revert; user gets tokens; RotationFailed event fires.
        escrow.claimByTwitter(nonce);
        assertEq(usdc.balanceOf(recipient), 100, "user paid despite rotation failure");
    }

    function test_F6_claim_succeedsWhenAdminRotationReverts() public {
        _credit(1, 0, address(usdc), 100);
        locker.setRevertAdmin(true);

        bytes32 nonce = bytes32("rotrev2");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        vm.warp(block.timestamp + escrow.claimTimelock() + 1);
        escrow.claimByTwitter(nonce);
        assertEq(usdc.balanceOf(recipient), 100);
    }

    // ============= F-7: veto refuses already-claimed slot =================

    function test_F7_veto_revertsIfSlotAlreadyClaimed() public {
        _credit(1, 0, address(usdc), 100);
        bytes32 nonce = bytes32("already");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        vm.warp(block.timestamp + escrow.claimTimelock() + 1);
        escrow.claimByTwitter(nonce);
        // After claim, p.consumed = true so veto reverts with AlreadyClaimed.
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.AlreadyClaimed.selector);
        escrow.veto(nonce);
    }

    // ============= F-9: deadline stored as uint256, no truncation =================

    function test_F9_deadline_storesFullUint256() public {
        _credit(1, 0, address(usdc), 100);
        // A very large deadline that would wrap if cast to uint64.
        uint256 deadline = uint256(type(uint64).max) + 100;
        bytes32 nonce = bytes32("future");
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        (,,,,,,,, uint256 storedDeadline,,) = escrow.pendingClaims(nonce);
        assertEq(storedDeadline, deadline, "full deadline preserved");
    }

    // ============= F-10: same-token aliasing rejected =================

    function test_F10_authorize_revertsOnSameTokenWithBothAmounts() public {
        _credit(1, 0, address(usdc), 100);
        bytes32 nonce = bytes32("alias");
        uint256 deadline = block.timestamp + 1 hours;
        // pairedToken == clankerToken == USDC, both > 0 -> revert.
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 50, address(usdc), 50, deadline, nonce);
        vm.expectRevert(ArcadeTwitterEscrowV3.InvalidTokens.selector);
        escrow.authorize(1, 0, recipient, address(usdc), 50, address(usdc), 50, deadline, nonce, sig);
    }

    function test_F10_authorize_allowsSameTokenWhenOneAmountZero() public {
        _credit(1, 0, address(usdc), 100);
        bytes32 nonce = bytes32("alias-ok");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(usdc), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(usdc), 0, deadline, nonce, sig);
    }

    // ============= Timelock + veto integration =================

    function test_timelock_blocksClaimUntilElapsed() public {
        vm.prank(OWNER);
        escrow.setClaimTimelock(1 hours);
        _credit(1, 0, address(usdc), 100);

        bytes32 nonce = bytes32("delayed");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);

        // Immediately: timelocked.
        vm.expectRevert(ArcadeTwitterEscrowV3.Timelocked.selector);
        escrow.claimByTwitter(nonce);

        // After timelock: succeeds.
        vm.warp(block.timestamp + 1 hours + 1);
        escrow.claimByTwitter(nonce);
        assertEq(usdc.balanceOf(recipient), 100);
    }

    function test_veto_duringTimelock_preventsClaim() public {
        vm.prank(OWNER);
        escrow.setClaimTimelock(1 hours);
        _credit(1, 0, address(usdc), 100);

        bytes32 nonce = bytes32("vetoed");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);

        vm.prank(OWNER);
        escrow.veto(nonce);

        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(ArcadeTwitterEscrowV3.AlreadyClaimed.selector);
        escrow.claimByTwitter(nonce);
    }

    function test_setClaimTimelock_capsAtMax() public {
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.TimelockTooLong.selector);
        escrow.setClaimTimelock(8 days);
    }

    // ============= Sanity =================

    function test_nonceReplay_revertsOnSecondAuthorize() public {
        _credit(1, 0, address(usdc), 200);
        bytes32 nonce = bytes32("replay");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
        vm.expectRevert(ArcadeTwitterEscrowV3.SlotPending.selector);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
    }

    function test_pastDeadline_revertsAuthorize() public {
        _credit(1, 0, address(usdc), 100);
        vm.warp(1000);
        uint256 deadline = 500;
        bytes32 nonce = bytes32("expired");
        bytes memory sig = _signClaim(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce);
        vm.expectRevert(ArcadeTwitterEscrowV3.DeadlineInPast.selector);
        escrow.authorize(1, 0, recipient, address(usdc), 100, address(0), 0, deadline, nonce, sig);
    }
}
