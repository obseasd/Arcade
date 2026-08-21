// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TokenFeeForwarder} from "../src/launchpad/TokenFeeForwarder.sol";

/// An 18-dp launch token (the token leg is the launch token, not USDC).
contract MockToken is ERC20 {
    constructor() ERC20("Launch", "LNCH") {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TokenFeeForwarderTest is Test {
    TokenFeeForwarder fwd;
    MockToken token;

    address constant OWNER = address(0x0bDE); // stand-in Safe
    address constant CALLER = address(0xCA11); // backend forwarder wallet
    address constant RECIPIENT = address(0xBEEF);

    // Mirror the event for expectEmit.
    event Forwarded(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        uint256 indexed positionId,
        uint256 slotIndex,
        bytes32 claimTxHash
    );
    event CallerSet(address indexed caller, bool allowed);

    function setUp() public {
        fwd = new TokenFeeForwarder(OWNER, CALLER); // owner = OWNER, CALLER seeded
        token = new MockToken();
        token.mint(CALLER, 10_000_000e18);
        vm.prank(CALLER);
        token.approve(address(fwd), type(uint256).max);
    }

    // ---- happy path ----------------------------------------------------

    function test_constructor_seedsOwnerAndCaller() public view {
        assertEq(fwd.owner(), OWNER, "owner = deployer");
        assertTrue(fwd.allowedCaller(CALLER), "initial caller seeded");
    }

    function test_forward_deliversAndEmits() public {
        uint256 amount = 1_393_964e18; // raw 18-dp launch-token amount
        uint256 positionId = uint256(0x1234);
        uint256 slotIndex = 1;
        bytes32 claimTx = keccak256("claimtx");

        vm.expectEmit(true, true, true, true, address(fwd));
        emit Forwarded(address(token), RECIPIENT, amount, positionId, slotIndex, claimTx);

        vm.prank(CALLER);
        fwd.forward(address(token), RECIPIENT, amount, positionId, slotIndex, claimTx);

        assertEq(token.balanceOf(RECIPIENT), amount, "recipient got the raw amount");
        assertEq(token.balanceOf(address(fwd)), 0, "forwarder holds nothing (custody-free)");
    }

    function test_forward_rawAmountNotScaled() public {
        // A tiny raw amount must arrive verbatim (no 1e6/1e12 scaling).
        uint256 amount = 7;
        vm.prank(CALLER);
        fwd.forward(address(token), RECIPIENT, amount, 1, 0, bytes32(0));
        assertEq(token.balanceOf(RECIPIENT), 7, "raw amount delivered verbatim");
    }

    function test_forward_pullsFromCallerNotContract() public {
        uint256 before = token.balanceOf(CALLER);
        vm.prank(CALLER);
        fwd.forward(address(token), RECIPIENT, 100e18, 1, 0, bytes32(0));
        assertEq(token.balanceOf(CALLER), before - 100e18, "pulled from caller");
    }

    // ---- access control ------------------------------------------------

    function test_forward_revertsUnauthorizedCaller() public {
        token.mint(address(0xBAD), 100e18);
        vm.prank(address(0xBAD));
        token.approve(address(fwd), type(uint256).max);
        vm.prank(address(0xBAD));
        vm.expectRevert(TokenFeeForwarder.NotAllowedCaller.selector);
        fwd.forward(address(token), RECIPIENT, 100e18, 1, 0, bytes32(0));
    }

    function test_forward_revokedCallerCannotForward() public {
        vm.prank(OWNER);
        fwd.setCaller(CALLER, false);
        vm.prank(CALLER);
        vm.expectRevert(TokenFeeForwarder.NotAllowedCaller.selector);
        fwd.forward(address(token), RECIPIENT, 100e18, 1, 0, bytes32(0));
    }

    function test_setCaller_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        fwd.setCaller(address(0x1234), true);
    }

    function test_setCaller_addsAndEmits() public {
        address newCaller = address(0xC0DE);
        vm.expectEmit(true, false, false, true, address(fwd));
        emit CallerSet(newCaller, true);
        vm.prank(OWNER);
        fwd.setCaller(newCaller, true);
        assertTrue(fwd.allowedCaller(newCaller));

        // and the new caller can actually forward
        token.mint(newCaller, 100e18);
        vm.prank(newCaller);
        token.approve(address(fwd), type(uint256).max);
        vm.prank(newCaller);
        fwd.forward(address(token), RECIPIENT, 100e18, 1, 0, bytes32(0));
        assertEq(token.balanceOf(RECIPIENT), 100e18);
    }

    function test_setCaller_zeroReverts() public {
        vm.prank(OWNER);
        vm.expectRevert(TokenFeeForwarder.ZeroAddress.selector);
        fwd.setCaller(address(0), true);
    }

    // ---- input validation ----------------------------------------------

    function test_forward_revertsZeroAmount() public {
        vm.prank(CALLER);
        vm.expectRevert(TokenFeeForwarder.NothingToForward.selector);
        fwd.forward(address(token), RECIPIENT, 0, 1, 0, bytes32(0));
    }

    function test_forward_revertsZeroToken() public {
        vm.prank(CALLER);
        vm.expectRevert(TokenFeeForwarder.ZeroAddress.selector);
        fwd.forward(address(0), RECIPIENT, 100e18, 1, 0, bytes32(0));
    }

    function test_forward_revertsZeroRecipient() public {
        vm.prank(CALLER);
        vm.expectRevert(TokenFeeForwarder.ZeroAddress.selector);
        fwd.forward(address(token), address(0), 100e18, 1, 0, bytes32(0));
    }

    function test_forward_revertsWithoutApproval() public {
        address c2 = address(0xC2);
        vm.prank(OWNER);
        fwd.setCaller(c2, true);
        token.mint(c2, 100e18);
        // no approve
        vm.prank(c2);
        vm.expectRevert(); // SafeERC20 / allowance failure
        fwd.forward(address(token), RECIPIENT, 100e18, 1, 0, bytes32(0));
    }

    function test_forward_revertsInsufficientBalance() public {
        address c3 = address(0xC3);
        vm.prank(OWNER);
        fwd.setCaller(c3, true);
        vm.prank(c3);
        token.approve(address(fwd), type(uint256).max);
        // c3 has zero balance
        vm.prank(c3);
        vm.expectRevert();
        fwd.forward(address(token), RECIPIENT, 1e18, 1, 0, bytes32(0));
    }

    // ---- rescue / ownership --------------------------------------------

    function test_rescue_onlyOwnerMovesDust() public {
        token.mint(address(fwd), 5e18); // stray donation
        vm.prank(OWNER);
        fwd.rescue(IERC20(address(token)), RECIPIENT, 5e18);
        assertEq(token.balanceOf(RECIPIENT), 5e18);
        assertEq(token.balanceOf(address(fwd)), 0);
    }

    function test_rescue_notOwnerReverts() public {
        token.mint(address(fwd), 5e18);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        fwd.rescue(IERC20(address(token)), RECIPIENT, 5e18);
    }

    function test_renounceOwnership_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert(TokenFeeForwarder.RenounceDisabled.selector);
        fwd.renounceOwnership();
    }

    function test_ownable2Step_transfer() public {
        address newOwner = address(0x0b2E);
        vm.prank(OWNER);
        fwd.transferOwnership(newOwner);
        assertEq(fwd.owner(), OWNER, "still old owner until accepted");
        vm.prank(newOwner);
        fwd.acceptOwnership();
        assertEq(fwd.owner(), newOwner, "two-step transfer complete");
    }
}
