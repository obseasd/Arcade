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
        assembly {
            mrWord := calldataload(add(message.offset, 184))
            amtWord := calldataload(add(message.offset, 216))
        }
        usdc.mint(address(uint160(uint256(mrWord))), uint256(amtWord));
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
    uint256 constant AMT = 1_000e6;

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
            address(v2Router)
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
        m = new bytes(568);
        bytes32 mr = bytes32(uint256(uint160(mintRecipient)));
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
            mstore(add(p, 184), mr)
            mstore(add(p, 216), amount)
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
