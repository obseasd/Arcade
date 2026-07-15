// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ArcadeCctpBuyReceiver} from "../src/cctp/ArcadeCctpBuyReceiver.sol";

/* ------------------------------- mocks -------------------------------- */

contract MintableERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Mints `amount` USDC (parsed from the message at byte 216) to the
/// mintRecipient (byte 184), mimicking CCTP V2 receiveMessage. Rejects a
/// replayed message like the real MessageTransmitter (nonce already used).
contract MockMessageTransmitter {
    MintableERC20 public usdc;
    mapping(bytes32 => bool) public used;

    constructor(MintableERC20 _usdc) {
        usdc = _usdc;
    }

    function receiveMessage(bytes calldata message, bytes calldata)
        external
        returns (bool)
    {
        bytes32 h = keccak256(message);
        require(!used[h], "message used");
        used[h] = true;
        bytes32 mrWord;
        bytes32 amtWord;
        bytes32 feeWord;
        assembly {
            mrWord := calldataload(add(message.offset, 184))
            amtWord := calldataload(add(message.offset, 216))
            feeWord := calldataload(add(message.offset, 312))
        }
        // Real CCTP mints amount MINUS the fee Circle actually took.
        usdc.mint(
            address(uint160(uint256(mrWord))),
            uint256(amtWord) - uint256(feeWord)
        );
        return true;
    }
}

/// Buys `token` at `rate` tokens per USDC, optionally refunding `refundBps`
/// of the input (curve-near-migration behaviour) or reverting (`failMode`).
contract MockLaunchpad {
    MintableERC20 public usdc;
    uint256 public rate = 2;
    uint256 public refundBps;
    bool public failMode;

    constructor(MintableERC20 _usdc) {
        usdc = _usdc;
    }

    function setFail(bool f) external {
        failMode = f;
    }

    function setRefundBps(uint256 b) external {
        refundBps = b;
    }

    function buy(address token, uint256 amountUsdcIn, uint256 minTokensOut)
        external
        returns (uint256 tokensOut, uint256 usdcSpent, uint256 refund)
    {
        require(!failMode, "buy failed");
        usdc.transferFrom(msg.sender, address(this), amountUsdcIn);
        refund = (amountUsdcIn * refundBps) / 10_000;
        usdcSpent = amountUsdcIn - refund;
        tokensOut = usdcSpent * rate;
        require(tokensOut >= minTokensOut, "slippage");
        MintableERC20(token).mint(msg.sender, tokensOut);
        if (refund > 0) usdc.transfer(msg.sender, refund);
    }
}

/// V3 venue: Arcade-style flat exactInputSingle. Swaps USDC -> tokenOut at
/// `rate`, delivered to `recipient`.
contract MockV3Router {
    MintableERC20 public usdc;
    uint256 public rate = 5;
    bool public failMode;

    constructor(MintableERC20 _usdc) {
        usdc = _usdc;
    }

    function setFail(bool f) external {
        failMode = f;
    }

    function exactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256
    ) external returns (uint256 amountOut) {
        require(!failMode, "v3 fail");
        MintableERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = amountIn * rate;
        require(amountOut >= amountOutMinimum, "v3 slippage");
        MintableERC20(tokenOut).mint(recipient, amountOut);
    }
}

/// AMM fallback: swaps USDC -> path[last] at `rate`, delivered to `to`.
contract MockV2Router {
    MintableERC20 public usdc;
    uint256 public rate = 3;
    bool public failMode;

    constructor(MintableERC20 _usdc) {
        usdc = _usdc;
    }

    function setFail(bool f) external {
        failMode = f;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(!failMode, "amm fail");
        usdc.transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * rate;
        require(out >= amountOutMin, "amm slippage");
        MintableERC20(path[path.length - 1]).mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}

/* -------------------------------- tests ------------------------------- */

contract ArcadeCctpBuyReceiverTest is Test {
    MintableERC20 usdc;
    MintableERC20 token;
    MockMessageTransmitter mt;
    MockLaunchpad launchpad;
    MockV2Router v2Router;
    MockV3Router v3Router;
    ArcadeCctpBuyReceiver receiver;

    address beneficiary = makeAddr("beneficiary");
    address attacker = makeAddr("attacker");
    address treasury = makeAddr("treasury");
    uint256 constant AMT = 1_000e6;
    // Fast transfer executed threshold (<=1000 == Fast); standard is 2000.
    uint32 constant FAST = 1000;
    uint32 constant STANDARD = 2000;

    function setUp() public {
        usdc = new MintableERC20("USDC", "USDC");
        token = new MintableERC20("Launch", "LAUNCH");
        mt = new MockMessageTransmitter(usdc);
        launchpad = new MockLaunchpad(usdc);
        v2Router = new MockV2Router(usdc);
        v3Router = new MockV3Router(usdc);
        receiver = new ArcadeCctpBuyReceiver(
            address(mt),
            address(usdc),
            address(launchpad),
            address(v2Router),
            treasury
        );
    }

    // Build a CCTP V2 `message` with mintRecipient at byte 184, amount at byte
    // 216, and hookData = abi.encode(ben, tok, minOut, ammRouter, v3Router,
    // v3Fee) (192 bytes, 6 words) at byte 376.
    function _msg(
        address mintRecipient,
        uint256 amount,
        address ben,
        address tok,
        uint256 minOut
    ) internal pure returns (bytes memory m) {
        // ammRouter/v3Router/v3Fee = 0 -> receiver uses its default v2Router.
        return _msgFull(mintRecipient, amount, ben, tok, minOut, address(0), address(0), 0);
    }

    function _msgFull(
        address mintRecipient,
        uint256 amount,
        address ben,
        address tok,
        uint256 minOut,
        address ammRouter,
        address v3RouterAddr,
        uint256 v3Fee
    ) internal pure returns (bytes memory m) {
        // Default: STANDARD transfer, no Circle fee -> no Arcade bridge fee, so
        // the pre-existing route tests keep their exact expected amounts.
        return
            _msgFee(
                mintRecipient,
                amount,
                ben,
                tok,
                minOut,
                ammRouter,
                v3RouterAddr,
                v3Fee,
                STANDARD,
                0
            );
    }

    function _msgFee(
        address mintRecipient,
        uint256 amount,
        address ben,
        address tok,
        uint256 minOut,
        address ammRouter,
        address v3RouterAddr,
        uint256 v3Fee,
        uint32 finalityExecuted,
        uint256 feeExecuted
    ) internal pure returns (bytes memory m) {
        m = new bytes(568);
        bytes32 mr = bytes32(uint256(uint160(mintRecipient)));
        // finalityThresholdExecuted is a uint32 at bytes 144-147.
        bytes32 fin = bytes32(uint256(finalityExecuted) << 224);
        bytes memory hook = abi.encode(
            ben,
            tok,
            minOut,
            ammRouter,
            v3RouterAddr,
            v3Fee
        ); // 192 bytes
        assembly {
            let p := add(m, 32)
            mstore(add(p, 144), fin)
            mstore(add(p, 184), mr)
            mstore(add(p, 216), amount)
            mstore(add(p, 312), feeExecuted)
            mstore(add(p, 376), mload(add(hook, 32)))
            mstore(add(p, 408), mload(add(hook, 64)))
            mstore(add(p, 440), mload(add(hook, 96)))
            mstore(add(p, 472), mload(add(hook, 128)))
            mstore(add(p, 504), mload(add(hook, 160)))
            mstore(add(p, 536), mload(add(hook, 192)))
        }
    }

    function test_happyPath_deliversTokensToBeneficiary() public {
        bytes memory m = _msg(address(receiver), AMT, beneficiary, address(token), 0);
        receiver.receiveAndBuy(m, "");
        assertEq(token.balanceOf(beneficiary), AMT * 2, "tokens to beneficiary");
        assertEq(usdc.balanceOf(address(receiver)), 0, "receiver holds no USDC");
        assertEq(token.balanceOf(address(receiver)), 0, "receiver holds no token");
    }

    function test_refundsLeftoverUsdc() public {
        launchpad.setRefundBps(2_000); // 20% refunded by the curve
        bytes memory m = _msg(address(receiver), AMT, beneficiary, address(token), 0);
        receiver.receiveAndBuy(m, "");
        // spent 800, tokensOut 1600, refund 200 -> both to beneficiary
        assertEq(token.balanceOf(beneficiary), 800e6 * 2, "tokens on spent amount");
        assertEq(usdc.balanceOf(beneficiary), 200e6, "leftover USDC refunded to beneficiary");
        assertEq(usdc.balanceOf(address(receiver)), 0, "receiver drained");
    }

    function test_refundsUsdcWhenBothRoutesRevert() public {
        launchpad.setFail(true);
        v2Router.setFail(true);
        bytes memory m = _msg(address(receiver), AMT, beneficiary, address(token), 0);
        receiver.receiveAndBuy(m, "");
        assertEq(usdc.balanceOf(beneficiary), AMT, "USDC returned to beneficiary");
        assertEq(token.balanceOf(beneficiary), 0, "no tokens");
        assertEq(usdc.balanceOf(address(receiver)), 0, "receiver drained");
        assertEq(usdc.allowance(address(receiver), address(launchpad)), 0, "launchpad approval reset");
        assertEq(usdc.allowance(address(receiver), address(v2Router)), 0, "router approval reset");
    }

    function test_ammFallback_deliversTokenWhenNotACurveToken() public {
        // Curve buy reverts (migrated / cirBTC / EURC) -> AMM route delivers.
        launchpad.setFail(true);
        bytes memory m = _msg(address(receiver), AMT, beneficiary, address(token), 0);
        receiver.receiveAndBuy(m, "");
        assertEq(token.balanceOf(beneficiary), AMT * 3, "tokens delivered via AMM (rate 3)");
        assertEq(usdc.balanceOf(beneficiary), 0, "no USDC refund on success");
        assertEq(usdc.balanceOf(address(receiver)), 0, "receiver drained");
    }

    function test_v3Route_deliversTokenViaV3() public {
        // ETH-style token: not a curve token, routed via V3 (v3Router + v3Fee
        // set). Curve reverts -> V3 leg delivers at rate 5.
        launchpad.setFail(true);
        bytes memory m = _msgFull(
            address(receiver),
            AMT,
            beneficiary,
            address(token),
            0,
            address(0), // ammRouter unused when V3 is selected
            address(v3Router),
            500
        );
        receiver.receiveAndBuy(m, "");
        assertEq(token.balanceOf(beneficiary), AMT * 5, "tokens via V3 (rate 5)");
        assertEq(usdc.balanceOf(beneficiary), 0, "no USDC refund on success");
        assertEq(usdc.balanceOf(address(receiver)), 0, "receiver drained");
        assertEq(usdc.allowance(address(receiver), address(v3Router)), 0, "v3 approval reset");
    }

    function test_v3Route_refundsWhenV3Reverts() public {
        launchpad.setFail(true);
        v3Router.setFail(true);
        bytes memory m = _msgFull(
            address(receiver),
            AMT,
            beneficiary,
            address(token),
            0,
            address(0),
            address(v3Router),
            500
        );
        receiver.receiveAndBuy(m, "");
        // V3 selected + failed -> refund (V2 is NOT tried when V3 is chosen).
        assertEq(usdc.balanceOf(beneficiary), AMT, "USDC returned when V3 fails");
        assertEq(token.balanceOf(beneficiary), 0, "no tokens");
        assertEq(usdc.allowance(address(receiver), address(v3Router)), 0, "v3 approval reset");
    }

    // --- bridge fee ----------------------------------------------------

    /// Fast transfer: all-in cost is pinned to 0.05% of the burned amount, so
    /// Arcade skims exactly the gap left by Circle's own fee.
    function test_bridgeFee_fastPinsAllInTo5Bps() public {
        // Circle's Base->Arc fast fee is 1.3bp = 130_000 of 1_000e6.
        uint256 circleFee = 130_000;
        bytes memory m = _msgFee(
            address(receiver), AMT, beneficiary, address(token), 0,
            address(0), address(0), 0, FAST, circleFee
        );
        receiver.receiveAndBuy(m, "");

        uint256 target = (AMT * 5) / 10_000; // 500_000 = 0.05%
        uint256 arcadeFee = target - circleFee; // 370_000
        assertEq(usdc.balanceOf(treasury), arcadeFee, "arcade skims the gap");
        // All-in the user gave up exactly 0.05%: circle 130k + arcade 370k.
        assertEq(circleFee + usdc.balanceOf(treasury), target, "all-in == 5bps");
        // The curve bought with the NET amount (minted 999.87 - fee 0.37).
        uint256 net = AMT - circleFee - arcadeFee;
        assertEq(token.balanceOf(beneficiary), net * 2, "buy uses net amount");
        assertEq(usdc.balanceOf(address(receiver)), 0, "receiver drained");
    }

    /// Standard transfer: Circle charges nothing, and neither do we.
    function test_bridgeFee_standardIsFree() public {
        bytes memory m = _msgFee(
            address(receiver), AMT, beneficiary, address(token), 0,
            address(0), address(0), 0, STANDARD, 0
        );
        receiver.receiveAndBuy(m, "");
        assertEq(usdc.balanceOf(treasury), 0, "no fee on standard transfer");
        assertEq(token.balanceOf(beneficiary), AMT * 2, "full amount bought");
    }

    /// If Circle's own fee already meets/exceeds the target, we skim zero
    /// rather than pushing the user above the advertised all-in.
    function test_bridgeFee_neverExceedsTarget() public {
        uint256 circleFee = (AMT * 9) / 10_000; // 9bp > 5bp target
        bytes memory m = _msgFee(
            address(receiver), AMT, beneficiary, address(token), 0,
            address(0), address(0), 0, FAST, circleFee
        );
        receiver.receiveAndBuy(m, "");
        assertEq(usdc.balanceOf(treasury), 0, "no skim when Circle exceeds target");
    }

    /// Plain bridge (no buy): fee skimmed, remainder forwarded.
    function test_receiveAndForward_takesFeeAndForwards() public {
        uint256 circleFee = 130_000;
        bytes memory m = _msgFee(
            address(receiver), AMT, beneficiary, address(0xdead), 0,
            address(0), address(0), 0, FAST, circleFee
        );
        receiver.receiveAndForward(m, "");
        uint256 arcadeFee = (AMT * 5) / 10_000 - circleFee;
        assertEq(usdc.balanceOf(treasury), arcadeFee, "fee to treasury");
        assertEq(
            usdc.balanceOf(beneficiary),
            AMT - circleFee - arcadeFee,
            "net USDC forwarded to beneficiary"
        );
        assertEq(usdc.balanceOf(address(receiver)), 0, "receiver drained");
    }

    function test_receiveAndForward_trustless() public {
        bytes memory m = _msgFee(
            address(receiver), AMT, beneficiary, address(0xdead), 0,
            address(0), address(0), 0, STANDARD, 0
        );
        vm.prank(attacker);
        receiver.receiveAndForward(m, "");
        assertEq(usdc.balanceOf(beneficiary), AMT, "goes to attested beneficiary");
        assertEq(usdc.balanceOf(attacker), 0, "attacker gets nothing");
    }

    function test_trustless_attackerCannotRedirect() public {
        // hookData commits beneficiary; a hostile caller still can't steal it.
        bytes memory m = _msg(address(receiver), AMT, beneficiary, address(token), 0);
        vm.prank(attacker);
        receiver.receiveAndBuy(m, "");
        assertEq(token.balanceOf(beneficiary), AMT * 2, "tokens go to attested beneficiary");
        assertEq(token.balanceOf(attacker), 0, "attacker gets nothing");
    }

    function test_revertsIfNotForThisReceiver() public {
        bytes memory m = _msg(attacker, AMT, beneficiary, address(token), 0);
        vm.expectRevert(ArcadeCctpBuyReceiver.NotForThisReceiver.selector);
        receiver.receiveAndBuy(m, "");
    }

    function test_revertsOnShortMessage() public {
        bytes memory m = new bytes(400); // < 472
        vm.expectRevert(ArcadeCctpBuyReceiver.BadMessage.selector);
        receiver.receiveAndBuy(m, "");
    }

    function test_revertsOnZeroBeneficiary() public {
        bytes memory m = _msg(address(receiver), AMT, address(0), address(token), 0);
        vm.expectRevert(ArcadeCctpBuyReceiver.BadMessage.selector);
        receiver.receiveAndBuy(m, "");
    }

    function test_replayedMessageReverts() public {
        bytes memory m = _msg(address(receiver), AMT, beneficiary, address(token), 0);
        receiver.receiveAndBuy(m, "");
        vm.expectRevert(); // MessageTransmitter rejects the reused nonce
        receiver.receiveAndBuy(m, "");
    }

    function test_slippageRevertRefundsUsdc() public {
        // minOut too high -> buy reverts on slippage -> caught -> USDC refunded.
        bytes memory m = _msg(address(receiver), AMT, beneficiary, address(token), 999_999e6);
        receiver.receiveAndBuy(m, "");
        assertEq(usdc.balanceOf(beneficiary), AMT, "USDC returned on slippage");
        assertEq(token.balanceOf(beneficiary), 0, "no tokens");
    }
}
