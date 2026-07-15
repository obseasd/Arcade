// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {ArcadeTwitterEscrowV3} from "../src/launchpad/ArcadeTwitterEscrowV3.sol";
import {ArcadeTokenVault} from "../src/launchpad/ArcadeTokenVault.sol";
import {IArcadeV3Factory, IArcadeV3Locker} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
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

interface ILockerSlots {
    function pendingSlotCredits(uint256, uint256, address) external view returns (uint256);
    function pushSlotCredit(uint256, uint256, address) external returns (uint256);
    function rotateSlot(uint256, uint256, address, address) external;
}

/**
 * REAL escrow + REAL locker. No mock on either side of the rotation.
 *
 * WHY THIS FILE EXISTS. The stranded-slot recovery
 * (escrow.rotateLockerSlot -> locker.rotateSlot -> locker.pushSlotCredit) was
 * asserted by NOTHING, and the two existing suites pointed at each other across
 * the gap:
 *
 *   - LockerEscrowIntegration.t.sol has the REAL locker but a MockEscrow with
 *     no `claimed` flag and no rotate path, so it vm.pranks the escrow's
 *     ADDRESS. Its own comment disclaims this and says reachability is "pinned
 *     in ArcadeTwitterEscrowV3.t.sol against the real contract instead".
 *   - ArcadeTwitterEscrowV3.t.sol has the REAL escrow but a MockLocker whose
 *     rotateSlot is an unconditional setter -- no ONLY_ADMIN, no ESCROW_PAIR.
 *     It asserts only that the escrow FORWARDED the arguments, and would pass
 *     identically if the real locker rejected the call.
 *
 * So the comment I wrote pointed at a proof that does not exist. An audit
 * caught it. The fix's correctness rests on three guards in a contract the
 * escrow's suite mocks away (ONLY_ADMIN, ESCROW_PAIR) plus launchpad M-13's
 * admin==escrow invariant; a regression in any of them would re-lock every
 * stranded slot with CI green.
 */
contract LockerEscrowRealPairTest is Test {
    MockUSDC usdc;
    MockWETH weth;
    ArcadeV2Factory v2Factory;
    ArcadeV2Router v2Router;
    ArcadeLaunchpad launchpad;
    ArcadeTwitterEscrowV3 escrow;
    address v3Factory;
    address v3Locker;
    address v3Router;
    ArcadeTokenVault tokenVault;

    address treasury = address(0xBEEF);
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);
    address twitterUser = address(0x7141);
    address OWNER = address(0x0BEE);
    uint256 signerPk;
    address signer;

    uint24 constant FEE = 10_000;

    bytes32 constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 positionId,uint256 slotIndex,address recipient,address pairedToken,uint256 pairedAmount,address clankerToken,uint256 clankerAmount,uint256 deadline,bytes32 nonce)"
    );

    function setUp() public {
        signerPk = uint256(keccak256("real-pair-signer"));
        signer = vm.addr(signerPk);

        usdc = new MockUSDC();
        weth = new MockWETH();
        v2Factory = new ArcadeV2Factory(address(this));
        v2Router = new ArcadeV2Router(address(v2Factory));
        v3Factory = _deploy("out-v3/UniswapV3Factory.sol/UniswapV3Factory.json", "");
        launchpad = new ArcadeLaunchpad(
            IERC20(address(usdc)), v2Factory, address(v2Router), treasury,
            IArcadeV3Factory(v3Factory), address(weth)
        );

        // BOOTSTRAP ORDER IS LOAD-BEARING: escrow first, then the locker built
        // with the escrow's address (twitterEscrow is immutable), then
        // setLocker -- which now verifies the wiring closes both ways.
        escrow = new ArcadeTwitterEscrowV3(signer, OWNER);
        v3Locker = _deploy(
            "out-v3/ArcadeV3Locker.sol/ArcadeV3Locker.json",
            abi.encode(address(launchpad), v3Factory, address(escrow), address(this))
        );
        vm.prank(OWNER);
        escrow.setLocker(v3Locker);

        v3Router = _deploy(
            "out-v3/ArcadeV3SwapRouter.sol/ArcadeV3SwapRouter.json",
            abi.encode(v3Factory, address(usdc), address(launchpad))
        );
        tokenVault = new ArcadeTokenVault(address(launchpad));
        launchpad.setV3Infra(v3Locker, v3Router, address(tokenVault));

        usdc.mint(alice, 1_000_000e6);
        usdc.mint(creator, 100e6);
    }

    function _deploy(string memory path, bytes memory args) internal returns (address addr) {
        bytes memory code = abi.encodePacked(vm.getCode(path), args);
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "deploy failed");
    }

    function _createWithEscrowSlot() internal returns (address token, uint256 positionId) {
        IArcadeV3Locker.Recipient[] memory rs = new IArcadeV3Locker.Recipient[](1);
        rs[0] = IArcadeV3Locker.Recipient(
            address(escrow), address(escrow), 10_000, IArcadeV3Locker.RewardToken.Both
        );
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        token = launchpad.createClankerV3(
            "Twitter Cat", "TCAT", "ipfs://x", rs,
            abi.encode(ArcadeLaunchpad.ClankerOptions(FEE, 0, 0, 0, 0, address(0), 0, 0, 0, 0))
        );
        vm.stopPrank();
        positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);
    }

    function _genFees(address token) internal {
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(
            address(usdc), token, FEE, alice, 20_000e6, 0, block.timestamp + 60
        );
        IERC20(token).approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(token, address(usdc), FEE, alice, got / 2, 0, block.timestamp + 60);
        vm.stopPrank();
    }

    function _sign(uint256 pid, uint256 slot, address rec, address pt, uint256 pa, bytes32 nonce, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(CLAIM_TYPEHASH, pid, slot, rec, pt, pa, address(0), uint256(0), dl, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// THE WHOLE CHAIN, real contracts end to end. Every step must pass a guard
    /// the other suites mock away.
    function test_realPair_strandedCreditIsRecoverableByTheUser() public {
        (address token, uint256 positionId) = _createWithEscrowSlot();
        _genFees(token);
        // Credit the escrow slot for real, via the locker.
        IArcadeV3Locker(v3Locker).collectFees(positionId);
        uint256 owed = escrow.balances(positionId, 0, address(usdc));
        assertGt(owed, 0, "escrow slot credited");

        // Claim, with the slot rotation forced to FAIL inside claimByTwitter's
        // try/catch -- the exact F-6 state.
        bytes32 nonce = bytes32("real");
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _sign(positionId, 0, twitterUser, address(usdc), owed, nonce, dl);
        vm.prank(twitterUser);
        escrow.authorize(positionId, 0, twitterUser, address(usdc), owed, address(0), 0, dl, nonce, sig);
        vm.warp(block.timestamp + escrow.claimTimelock() + 1);
        vm.mockCallRevert(
            v3Locker,
            abi.encodeWithSelector(ILockerSlots.rotateSlot.selector, positionId, uint256(0), twitterUser, twitterUser),
            "ROTATION_DOWN"
        );
        escrow.claimByTwitter(nonce);
        vm.clearMockedCalls();
        assertTrue(escrow.claimed(positionId, 0), "claimed despite the failed rotation");

        // Every later collectFees now strands: creditSlot reverts
        // SlotAlreadyClaimed because the slot still points at the escrow.
        _genFees(token);
        IArcadeV3Locker(v3Locker).collectFees(positionId);
        uint256 stranded = ILockerSlots(v3Locker).pendingSlotCredits(positionId, 0, address(usdc));
        assertGt(stranded, 0, "stranded in the locker");

        // THE EXIT. Owner rotates via the escrow (the only address the locker
        // accepts, since M-13 makes the escrow the slot's admin), then anyone
        // pushes. This is what no committed test proved.
        vm.prank(OWNER);
        escrow.rotateLockerSlot(positionId, 0, twitterUser, twitterUser);

        uint256 before = usdc.balanceOf(twitterUser);
        vm.prank(address(0xDEADBEEF));
        ILockerSlots(v3Locker).pushSlotCredit(positionId, 0, address(usdc));
        assertEq(usdc.balanceOf(twitterUser) - before, stranded, "the USER is paid, by the REAL pair");
        assertEq(
            ILockerSlots(v3Locker).pendingSlotCredits(positionId, 0, address(usdc)), 0, "ledger cleared"
        );
    }

    /// The owner must not be able to touch a slot whose claim rotated fine: the
    /// `claimed` gate PASSES there, so the locker's ONLY_ADMIN is what saves the
    /// user. That is a guard MockLocker does not have, so only a real pair can
    /// assert it.
    function test_realPair_ownerCannotTouchASuccessfullyRotatedSlot() public {
        (address token, uint256 positionId) = _createWithEscrowSlot();
        _genFees(token);
        IArcadeV3Locker(v3Locker).collectFees(positionId);
        uint256 owed = escrow.balances(positionId, 0, address(usdc));

        bytes32 nonce = bytes32("ok");
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _sign(positionId, 0, twitterUser, address(usdc), owed, nonce, dl);
        vm.prank(twitterUser);
        escrow.authorize(positionId, 0, twitterUser, address(usdc), owed, address(0), 0, dl, nonce, sig);
        vm.warp(block.timestamp + escrow.claimTimelock() + 1);
        escrow.claimByTwitter(nonce); // rotation SUCCEEDS -> admin becomes the user

        vm.prank(OWNER);
        vm.expectRevert(bytes("ONLY_ADMIN"));
        escrow.rotateLockerSlot(positionId, 0, OWNER, OWNER);
    }

    /// setLocker must refuse a locker that does not point back at this escrow.
    /// Against the REAL locker, whose twitterEscrow is immutable.
    function test_realPair_setLocker_rejectsAnUnpairedLocker() public {
        ArcadeTwitterEscrowV3 fresh = new ArcadeTwitterEscrowV3(signer, OWNER);
        vm.prank(OWNER);
        vm.expectRevert(ArcadeTwitterEscrowV3.ZeroAddress.selector);
        fresh.setLocker(v3Locker); // points at `escrow`, not `fresh`
    }
}
