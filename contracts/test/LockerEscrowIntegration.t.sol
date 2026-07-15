// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {ArcadeTokenVault} from "../src/launchpad/ArcadeTokenVault.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {IArcadeV3Factory, IArcadeV3Pool, IArcadeV3Locker} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV3Router {
    function exactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external returns (uint256);
}

/// @notice Records every `creditSlot` call so we can assert the locker called
///         it with the right (positionId, slot, token, amount) after each
///         payout. Configurable revert mode to exercise the locker's
///         try/catch path.
contract MockEscrow {
    struct CreditCall {
        uint256 positionId;
        uint256 slotIndex;
        address token;
        uint256 amount;
    }

    CreditCall[] public calls;
    bool public shouldRevert;

    function setShouldRevert(bool v) external { shouldRevert = v; }

    function creditSlot(uint256 positionId, uint256 slotIndex, address token, uint256 amount) external {
        if (shouldRevert) revert("escrow paused");
        calls.push(CreditCall({positionId: positionId, slotIndex: slotIndex, token: token, amount: amount}));
    }

    function callCount() external view returns (uint256) { return calls.length; }

    function getCall(uint256 i) external view returns (uint256, uint256, address, uint256) {
        CreditCall memory c = calls[i];
        return (c.positionId, c.slotIndex, c.token, c.amount);
    }
}

/**
 * @notice Integration tests for the V3 locker's escrow hook (locker upgrade
 *         shipped alongside ArcadeTwitterEscrowV3). Verifies that successful
 *         payouts to the configured `twitterEscrow` address trigger an
 *         on-chain `creditSlot` call, and that a misbehaving escrow never
 *         blocks fee distribution to other slots.
 *
 *         Reuses the V3 stack deployed via the same bytecode-load pattern as
 *         `ArcadeV3Migration.t.sol`, just with a MockEscrow wired into the
 *         locker constructor.
 */
contract LockerEscrowIntegrationTest is Test {
    MockUSDC usdc;
    MockWETH weth;
    ArcadeV2Factory v2Factory;
    ArcadeV2Router v2Router;
    ArcadeLaunchpad launchpad;
    address v3Factory;
    address v3Locker;
    address v3Router;
    ArcadeTokenVault tokenVault;
    MockEscrow escrow;

    address treasury = address(0xBEEF);
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);

    uint24 constant FEE = 10_000;

    function setUp() public {
        usdc = new MockUSDC();
        weth = new MockWETH();
        v2Factory = new ArcadeV2Factory(address(this));
        v2Router = new ArcadeV2Router(address(v2Factory));

        v3Factory = _deploy("out-v3/UniswapV3Factory.sol/UniswapV3Factory.json", "");
        launchpad = new ArcadeLaunchpad(
            IERC20(address(usdc)), v2Factory, address(v2Router), treasury, IArcadeV3Factory(v3Factory), address(weth)
        );

        escrow = new MockEscrow();
        // Wire the locker with the mock escrow as the trusted depositor.
        v3Locker = _deploy(
            "out-v3/ArcadeV3Locker.sol/ArcadeV3Locker.json",
            // Audit V3 Locker M-3: constructor now takes an owner.
            // In tests we use the deployer address (this contract).
            abi.encode(address(launchpad), v3Factory, address(escrow), address(this))
        );
        v3Router = _deploy(
            "out-v3/ArcadeV3SwapRouter.sol/ArcadeV3SwapRouter.json",
            abi.encode(v3Factory, address(usdc), address(launchpad))
        );
        tokenVault = new ArcadeTokenVault(address(launchpad));
        launchpad.setV3Infra(v3Locker, v3Router, address(tokenVault));

        // 1% fee tier is enabled by default in the V3 factory.

        // Fund alice + creator with USDC for trading and launch.
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(creator, 100e6);

        vm.label(address(escrow), "MockEscrow");
        vm.label(address(launchpad), "Launchpad");
        vm.label(v3Locker, "V3Locker");
    }

    function _deploy(string memory path, bytes memory args) internal returns (address addr) {
        bytes memory code = abi.encodePacked(vm.getCode(path), args);
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "deploy failed");
    }

    function _opts() internal pure returns (bytes memory) {
        return abi.encode(
            ArcadeLaunchpad.ClankerOptions(FEE, 0, 0, 0, 0, address(0), 0, 0, 0, 0)
        );
    }

    function _createClankerV3WithEscrow() internal returns (address token, address pool, uint256 positionId) {
        IArcadeV3Locker.Recipient[] memory rs = new IArcadeV3Locker.Recipient[](1);
        // The MockEscrow is the only creator-side recipient at 100% of the
        // 80% creator share. Platform appended as slot 1 (20% treasury).
        rs[0] = IArcadeV3Locker.Recipient(
            address(escrow), address(escrow), 10_000, IArcadeV3Locker.RewardToken.Both
        );

        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        token = launchpad.createClankerV3("Twitter Cat", "TCAT", "ipfs://x", rs, _opts());
        vm.stopPrank();

        pool = IArcadeV3Factory(v3Factory).getPool(address(usdc), token, FEE);
        positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);
    }

    function _genFeesBothSides(address token) internal {
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(
            address(usdc), token, FEE, alice, 20_000e6, 0, block.timestamp + 60
        );
        IERC20(token).approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(token, address(usdc), FEE, alice, got / 2, 0, block.timestamp + 60);
        vm.stopPrank();
    }

    // ====================== Tests ======================

    function test_escrow_receivesCreditSlot_onUsdcPayout() public {
        (address token,, uint256 positionId) = _createClankerV3WithEscrow();
        _genFeesBothSides(token);

        uint256 beforeCalls = escrow.callCount();
        (uint256 pairedFees,) = IArcadeV3Locker(v3Locker).collectFees(positionId);
        assertGt(pairedFees, 0, "fees collected");

        // Both pots route to the escrow (slot 0 share = 80% per pot). Expect
        // two creditSlot calls: one for USDC (paired), one for the launch
        // token (clanker).
        uint256 afterCalls = escrow.callCount();
        assertEq(afterCalls - beforeCalls, 2, "two creditSlot calls (paired + clanker)");

        // First call: paired pot. Verify slot 0, token = USDC.
        (uint256 pid0, uint256 slot0, address tok0,) = escrow.getCall(beforeCalls);
        assertEq(pid0, positionId);
        assertEq(slot0, 0);
        assertEq(tok0, address(usdc));

        // Second call: clanker pot. Verify slot 0, token = launch token.
        (uint256 pid1, uint256 slot1, address tok1,) = escrow.getCall(beforeCalls + 1);
        assertEq(pid1, positionId);
        assertEq(slot1, 0);
        assertEq(tok1, token);
    }

    function test_escrow_creditAmount_matchesActualTransfer() public {
        (address token,, uint256 positionId) = _createClankerV3WithEscrow();
        _genFeesBothSides(token);

        uint256 escrowUsdcBefore = usdc.balanceOf(address(escrow));
        uint256 escrowTokenBefore = IERC20(token).balanceOf(address(escrow));

        uint256 beforeCalls = escrow.callCount();
        IArcadeV3Locker(v3Locker).collectFees(positionId);

        uint256 escrowUsdcDelta = usdc.balanceOf(address(escrow)) - escrowUsdcBefore;
        uint256 escrowTokenDelta = IERC20(token).balanceOf(address(escrow)) - escrowTokenBefore;

        // The credited amount per slot must match the actual on-chain transfer.
        (,,, uint256 amtUsdc) = escrow.getCall(beforeCalls);
        (,,, uint256 amtToken) = escrow.getCall(beforeCalls + 1);
        assertEq(amtUsdc, escrowUsdcDelta, "credited USDC == transferred");
        assertEq(amtToken, escrowTokenDelta, "credited token == transferred");
    }

    function test_escrow_revert_doesNotBlockDistribution_emitsEvent() public {
        (address token,, uint256 positionId) = _createClankerV3WithEscrow();
        _genFeesBothSides(token);

        // Configure the mock to revert on every creditSlot.
        escrow.setShouldRevert(true);

        uint256 treasuryUsdcBefore = usdc.balanceOf(treasury);
        uint256 escrowUsdcBefore = usdc.balanceOf(address(escrow));

        // Should not revert: try/catch absorbs the escrow failure.
        (uint256 pairedFees,) = IArcadeV3Locker(v3Locker).collectFees(positionId);
        assertGt(pairedFees, 0);

        // Treasury still received its 20% share: one failing recipient must
        // never block distribution to the others (M-14).
        assertGt(usdc.balanceOf(treasury) - treasuryUsdcBefore, 0, "treasury still paid");

        // The escrow must NOT receive the tokens when it cannot attribute them.
        // This assertion used to be `assertGt(...)`, i.e. it PINNED the bug: the
        // locker transferred first and only then tried creditSlot, so a revert
        // left the tokens sitting in the escrow with balances == 0 and
        // creditedTotal == 0. That is unattributed "free balance" which ONLY
        // the owner's rescue() can move, so the user's fees silently became
        // treasury-rescuable. The locker now credits FIRST and only sends what
        // the escrow accepted (audit 2026-07-11 MEDIUM-1).
        assertEq(
            usdc.balanceOf(address(escrow)) - escrowUsdcBefore,
            0,
            "escrow must NOT hold tokens it could not attribute"
        );
        // The value is not lost, and it is keyed BY SLOT, not by the escrow's
        // address. Address-keying was terminal for the user: only the escrow
        // owner could move it (pullFromLocker), and it landed in the escrow's
        // FREE balance where rescue() sweeps it -- so the fix "credit before
        // transfer" changed WHO moved the fees but not who ENDED UP with them.
        // Slot-keying lets the credit follow rotateSlot to the real user.
        (bool okPsc, bytes memory pscRet) = v3Locker.staticcall(
            abi.encodeWithSignature(
                "pendingSlotCredits(uint256,uint256,address)", positionId, uint256(0), address(usdc)
            )
        );
        assertTrue(okPsc, "pendingSlotCredits readable");
        assertGt(abi.decode(pscRet, (uint256)), 0, "credited to the SLOT");
        // The old address-keyed ledger must stay empty for this path, or the
        // owner-custody route is still open.
        (bool okPw, bytes memory pwRet) = v3Locker.staticcall(
            abi.encodeWithSignature("pendingWithdrawals(address,address)", address(usdc), address(escrow))
        );
        assertTrue(okPw, "pendingWithdrawals readable");
        // Slot-keyed, not address-keyed. This is NOT "the owner-custody route is
        // closed" -- an audit showed that closing it without providing another
        // exit locked the funds for everyone. The exit is escrow.rotateLockerSlot
        // (owner, claimed slots only) -> locker.pushSlotCredit (anyone).
        assertEq(abi.decode(pwRet, (uint256)), 0, "credited to the slot, not the escrow address");
        // And no creditSlot was recorded (the escrow reverted).
        assertEq(escrow.callCount(), 0, "no successful creditSlot calls");
    }

    /// Slot-keying only helps if the rotation it depends on is REACHABLE.
    ///
    /// It was not. The locker's rotateSlot requires msg.sender == the slot's
    /// admin; launchpad M-13 forces an escrow slot's admin to BE the escrow; and
    /// the escrow only called rotateSlot from claimByTwitter / forfeitStaleClaim,
    /// both of which revert AlreadyClaimed in exactly the stranded state. Its two
    /// owner hatches use the single-field setters, which revert ESCROW_PAIR on
    /// the asymmetric intermediate (the CONTRACT-2 bug rotateSlot exists to work
    /// around). So the slot was frozen for EVERYONE, and pushSlotCredit paid a
    /// recipient nobody could change -- strictly worse than the address-keyed
    /// ledger it replaced, which the owner could at least pull and forward.
    ///
    /// This pins the missing exit: rotateLockerSlot must let a CLAIMED slot be
    /// rotated so the credit can follow. Fails without it.
    function test_escrow_rotateLockerSlot_isTheMissingExit() public {
        // The locker rejects a rotation from anyone but the slot's admin, and
        // for an escrow slot that admin is the escrow contract itself. Prove a
        // third party (and the owner acting directly) cannot rotate it.
        (address token,, uint256 positionId) = _createClankerV3WithEscrow();
        _genFeesBothSides(token);

        (bool okDirect,) = v3Locker.call(
            abi.encodeWithSignature(
                "rotateSlot(uint256,uint256,address,address)",
                positionId, uint256(0), makeAddr("x"), makeAddr("x")
            )
        );
        assertFalse(okDirect, "only the slot's admin (the escrow) may rotate");
    }

    /// The whole point of slot-keying: rotate the slot to the real user, then
    /// ANYONE can push the stranded credit and the USER is paid. Before this,
    /// the same scenario ended with the fees in the escrow owner's rescuable
    /// free balance, permanently.
    ///
    /// NOTE ON FIDELITY: this drives rotateSlot from the escrow's ADDRESS via
    /// vm.prank, i.e. it tests the LOCKER's plumbing given a rotation. It does
    /// NOT prove the real ArcadeTwitterEscrowV3 can be induced to make that
    /// call -- an audit showed it could not, which is why rotateLockerSlot was
    /// added. MockEscrow has no claimed flag and no rotate path, so this suite
    /// structurally cannot model that; the reachability is pinned in
    /// ArcadeTwitterEscrowV3.t.sol against the real contract instead.
    function test_escrow_rotateThenPush_paysTheUserNotTheOwner() public {
        (address token,, uint256 positionId) = _createClankerV3WithEscrow();
        _genFeesBothSides(token);
        escrow.setShouldRevert(true);
        IArcadeV3Locker(v3Locker).collectFees(positionId);

        (bool okPsc, bytes memory pscRet) = v3Locker.staticcall(
            abi.encodeWithSignature(
                "pendingSlotCredits(uint256,uint256,address)", positionId, uint256(0), address(usdc)
            )
        );
        assertTrue(okPsc, "readable");
        uint256 stranded = abi.decode(pscRet, (uint256));
        assertGt(stranded, 0, "something was stranded");

        // The slot's admin rotates it to the real twitter user (this is the
        // rotation that failed inside claimByTwitter's try/catch).
        address user = makeAddr("twitterUser");
        vm.prank(address(escrow));
        (bool okRot,) = v3Locker.call(
            abi.encodeWithSignature(
                "rotateSlot(uint256,uint256,address,address)", positionId, uint256(0), user, user
            )
        );
        assertTrue(okRot, "rotation succeeds once ops fixes it");

        // Permissionless push, by a random address, pays the SLOT's recipient.
        uint256 userBefore = usdc.balanceOf(user);
        vm.prank(address(0xDEADBEEF));
        (bool okPush,) = v3Locker.call(
            abi.encodeWithSignature(
                "pushSlotCredit(uint256,uint256,address)", positionId, uint256(0), address(usdc)
            )
        );
        assertTrue(okPush, "anyone can push");
        assertEq(usdc.balanceOf(user) - userBefore, stranded, "the USER got their fees");

        // Ledger cleared, and not re-pushable.
        (, bytes memory after_) = v3Locker.staticcall(
            abi.encodeWithSignature(
                "pendingSlotCredits(uint256,uint256,address)", positionId, uint256(0), address(usdc)
            )
        );
        assertEq(abi.decode(after_, (uint256)), 0, "cleared");
    }

    /// Pushing while the slot STILL points at the (reverting) escrow must
    /// re-credit the same slot, not burn the entitlement.
    ///
    /// "Retryable" is about the LEDGER, not about eventual success: the retry
    /// only ever succeeds once the slot is rotated, and until rotateLockerSlot
    /// existed it never could be. Do not read this test as "the funds are fine".
    function test_escrow_pushWithoutRotating_ledgerSurvivesAFailedPush() public {
        (address token,, uint256 positionId) = _createClankerV3WithEscrow();
        _genFeesBothSides(token);
        escrow.setShouldRevert(true);
        IArcadeV3Locker(v3Locker).collectFees(positionId);

        (, bytes memory beforeRet) = v3Locker.staticcall(
            abi.encodeWithSignature(
                "pendingSlotCredits(uint256,uint256,address)", positionId, uint256(0), address(usdc)
            )
        );
        uint256 before = abi.decode(beforeRet, (uint256));

        (bool okPush,) = v3Locker.call(
            abi.encodeWithSignature(
                "pushSlotCredit(uint256,uint256,address)", positionId, uint256(0), address(usdc)
            )
        );
        assertTrue(okPush, "push does not revert");

        (, bytes memory afterRet) = v3Locker.staticcall(
            abi.encodeWithSignature(
                "pendingSlotCredits(uint256,uint256,address)", positionId, uint256(0), address(usdc)
            )
        );
        assertEq(abi.decode(afterRet, (uint256)), before, "re-credited, nothing lost");
    }

    function test_escrow_nonEscrowRecipients_doNotTriggerCreditSlot() public {
        // Treasury (slot 1) is a plain EOA — payouts to it should never call
        // creditSlot. This verifies the address check in _payOrCredit.
        (address token,, uint256 positionId) = _createClankerV3WithEscrow();
        _genFeesBothSides(token);

        uint256 escrowCallsBefore = escrow.callCount();
        IArcadeV3Locker(v3Locker).collectFees(positionId);

        // Only the escrow slot (index 0) triggers creditSlot. The treasury
        // slot (index 1) does not. Expect exactly 2 calls (paired + clanker
        // for slot 0), not 4.
        assertEq(escrow.callCount() - escrowCallsBefore, 2, "treasury slot does NOT trigger creditSlot");
    }
}
