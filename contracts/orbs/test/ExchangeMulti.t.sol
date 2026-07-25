// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "forge-std/Test.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ExchangeMulti} from "src/exchange/ExchangeMulti.sol";

/**
 * A minimal approve-to-router DEX: pulls `amountIn` src from its caller (the
 * adapter, via the approval the adapter set) and pays a configured amount of dst
 * to `recipient`. Stands in for Arcade V2/V3/XyloNet routers.
 */
contract MockRouter {
    using SafeERC20 for IERC20;

    uint256 public outAmount;

    function setOut(uint256 a) external {
        outAmount = a;
    }

    function doSwap(address src, address dst, uint256 amountIn, address recipient) external {
        IERC20(src).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(dst).safeTransfer(recipient, outAmount);
    }
}

/** A router that returns MORE approval-consuming behaviour to check we zero it. */
contract MockPartialRouter {
    using SafeERC20 for IERC20;

    uint256 public outAmount;

    function setOut(uint256 a) external {
        outAmount = a;
    }

    // pulls only HALF of amountIn — leaves residual approval the adapter must zero
    function doSwap(address src, address dst, uint256 amountIn, address recipient) external {
        IERC20(src).safeTransferFrom(msg.sender, address(this), amountIn / 2);
        IERC20(dst).safeTransfer(recipient, outAmount);
    }
}

contract ExchangeMultiTest is Test {
    using SafeERC20 for IERC20;

    ExchangeMulti public exchange;
    MockRouter public router;
    ERC20 public src;
    ERC20 public dst;

    address public keeper = makeAddr("keeper");
    address public attacker = makeAddr("attacker");
    address public owner; // = address(this)

    uint256 constant AMOUNT_IN = 100e6; // 100 USDC (6dp)
    uint256 constant OUT = 5 ether; // 5 dst (18dp)

    function setUp() public {
        owner = address(this);
        router = new MockRouter();

        address[] memory takers = new address[](1);
        takers[0] = keeper;
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        exchange = new ExchangeMulti(takers, routers);

        src = new ERC20("src", "SRC");
        dst = new ERC20("dst", "DST");

        // Fund the router with dst so it can pay out, and fund TWAP (this test
        // acts as TWAP: it approves the adapter and receives the output).
        deal(address(dst), address(router), 1_000 ether);
        deal(address(src), address(this), 1_000e6);
        src.approve(address(exchange), type(uint256).max);
        router.setOut(OUT);
    }

    function _bid(address r, uint256 committedOut) internal view returns (bytes memory) {
        bytes memory swapData =
            abi.encodeCall(MockRouter.doSwap, (address(src), address(dst), AMOUNT_IN, address(exchange)));
        return abi.encode(committedOut, r, swapData);
    }

    // --- getAmountOut ---

    function test_getAmountOut_returnsCommitted_forAllowedTaker() public {
        uint256 q = exchange.getAmountOut(address(src), address(dst), AMOUNT_IN, "", _bid(address(router), OUT), keeper);
        assertEq(q, OUT);
    }

    function test_getAmountOut_revertsForUnknownTaker() public {
        vm.expectRevert(abi.encodeWithSelector(ExchangeMulti.TakerNotAllowed.selector, attacker));
        exchange.getAmountOut(address(src), address(dst), AMOUNT_IN, "", _bid(address(router), OUT), attacker);
    }

    // --- swap happy path ---

    function test_swap_executesAndForwardsOutput() public {
        uint256 before = dst.balanceOf(address(this));
        exchange.swap(address(src), address(dst), AMOUNT_IN, OUT, "", _bid(address(router), OUT), keeper);
        assertEq(dst.balanceOf(address(this)) - before, OUT, "TWAP receives the whole output");
        assertEq(src.balanceOf(address(exchange)), 0, "adapter holds no leftover src");
        assertEq(dst.balanceOf(address(exchange)), 0, "adapter holds no leftover dst");
        assertEq(src.allowance(address(exchange), address(router)), 0, "approval zeroed after fill");
    }

    // --- security gates ---

    function test_swap_revertsForUnknownTaker() public {
        vm.expectRevert(abi.encodeWithSelector(ExchangeMulti.TakerNotAllowed.selector, attacker));
        exchange.swap(address(src), address(dst), AMOUNT_IN, OUT, "", _bid(address(router), OUT), attacker);
    }

    function test_swap_revertsForUnallowedRouter() public {
        MockRouter evil = new MockRouter();
        deal(address(dst), address(evil), 1_000 ether);
        evil.setOut(OUT);
        vm.expectRevert(abi.encodeWithSelector(ExchangeMulti.RouterNotAllowed.selector, address(evil)));
        exchange.swap(address(src), address(dst), AMOUNT_IN, OUT, "", _bid(address(evil), OUT), keeper);
    }

    function test_swap_revertsWhenOutputBelowMinOut() public {
        // Router pays only OUT but the fill demands OUT+1 -> InsufficientOutputAmount.
        vm.expectRevert(abi.encodeWithSelector(ExchangeMulti.InsufficientOutputAmount.selector, OUT, OUT + 1));
        exchange.swap(address(src), address(dst), AMOUNT_IN, OUT + 1, "", _bid(address(router), OUT), keeper);
    }

    function test_swap_zeroesResidualApprovalOnPartialConsumption() public {
        MockPartialRouter partialRouter = new MockPartialRouter();
        deal(address(dst), address(partialRouter), 1_000 ether);
        partialRouter.setOut(OUT);
        exchange.setRouterAllowed(address(partialRouter), true);

        bytes memory swapData =
            abi.encodeCall(MockPartialRouter.doSwap, (address(src), address(dst), AMOUNT_IN, address(exchange)));
        bytes memory bidData = abi.encode(OUT, address(partialRouter), swapData);

        exchange.swap(address(src), address(dst), AMOUNT_IN, OUT, "", bidData, keeper);
        assertEq(src.allowance(address(exchange), address(partialRouter)), 0, "residual approval zeroed");
        // The unspent half stays in the adapter? No -- forceApprove(0) does not move
        // tokens; the leftover src remains in the adapter. Assert it is recoverable
        // context: in production the keeper always consumes the full amountIn on a
        // real router, so this only guards the approval, not fund custody.
        assertEq(src.balanceOf(address(exchange)), AMOUNT_IN / 2, "unspent src remains (keeper always spends full in prod)");
    }

    // --- governance ---

    function test_setRouterAllowed_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        exchange.setRouterAllowed(address(0xBEEF), true);
    }

    function test_setTakerAllowed_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        exchange.setTakerAllowed(attacker, true);
    }

    function test_owner_canAddAndRemoveRouter() public {
        address r = address(0xBEEF);
        assertFalse(exchange.allowedRouter(r));
        exchange.setRouterAllowed(r, true);
        assertTrue(exchange.allowedRouter(r));
        exchange.setRouterAllowed(r, false);
        assertFalse(exchange.allowedRouter(r));
    }

    function test_owner_canAddTaker() public {
        address k2 = makeAddr("keeper2");
        assertFalse(exchange.allowedTaker(k2));
        exchange.setTakerAllowed(k2, true);
        assertTrue(exchange.allowedTaker(k2));
    }

    function test_constructor_seedsTakersAndRouters() public {
        assertTrue(exchange.allowedTaker(keeper));
        assertTrue(exchange.allowedRouter(address(router)));
        assertEq(exchange.owner(), owner);
    }

    // --- M-1: rescue stranded funds ---

    function test_rescue_movesStrandedSrc_onlyOwner() public {
        // Simulate a refunding router that left src dust in the adapter.
        deal(address(src), address(exchange), 7e6);
        uint256 before = src.balanceOf(owner);
        exchange.rescue(IERC20(address(src)), owner, 7e6);
        assertEq(src.balanceOf(owner) - before, 7e6);
        assertEq(src.balanceOf(address(exchange)), 0);
    }

    function test_rescue_revertsForNonOwner() public {
        deal(address(src), address(exchange), 1e6);
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        exchange.rescue(IERC20(address(src)), attacker, 1e6);
    }

    function test_rescue_rejectsZeroRecipient() public {
        vm.expectRevert(ExchangeMulti.ZeroAddress.selector);
        exchange.rescue(IERC20(address(src)), address(0), 0);
    }

    // --- L-3: ownership lifecycle (Ownable2Step + renounce disabled) ---

    function test_renounce_disabled() public {
        vm.expectRevert(ExchangeMulti.RenounceDisabled.selector);
        exchange.renounceOwnership();
    }

    function test_transferOwnership_isTwoStep() public {
        address safe = makeAddr("safe");
        exchange.transferOwnership(safe);
        // Pending, not yet effective: old owner still in control.
        assertEq(exchange.owner(), owner);
        assertEq(exchange.pendingOwner(), safe);
        // Only the pending owner can accept.
        vm.prank(attacker);
        vm.expectRevert("Ownable2Step: caller is not the new owner");
        exchange.acceptOwnership();
        vm.prank(safe);
        exchange.acceptOwnership();
        assertEq(exchange.owner(), safe);
    }

    // --- L-4: zero-address guards ---

    function test_setRouterAllowed_rejectsZero() public {
        vm.expectRevert(ExchangeMulti.ZeroAddress.selector);
        exchange.setRouterAllowed(address(0), true);
    }

    function test_setTakerAllowed_rejectsZero() public {
        vm.expectRevert(ExchangeMulti.ZeroAddress.selector);
        exchange.setTakerAllowed(address(0), true);
    }

    function test_constructor_rejectsZeroRouter() public {
        address[] memory takers = new address[](1);
        takers[0] = keeper;
        address[] memory routers = new address[](1);
        routers[0] = address(0);
        vm.expectRevert(ExchangeMulti.ZeroAddress.selector);
        new ExchangeMulti(takers, routers);
    }

    // --- FoT src: the balanceOf re-read branch (M-2 coverage) ---

    function test_swap_supportsFeeOnTransferSrc() public {
        // A src that burns 10% on transfer. amountIn = balanceOf(this) after the
        // pull must reflect the RECEIVED amount, and the router is approved that.
        FeeToken fot = new FeeToken();
        deal(address(fot), address(this), 1_000e6);
        fot.approve(address(exchange), type(uint256).max);
        // adapter receives 90% of AMOUNT_IN; router pulls exactly that.
        uint256 received = (AMOUNT_IN * 90) / 100;
        MockRouter r2 = new MockRouter();
        deal(address(dst), address(r2), 1_000 ether);
        r2.setOut(OUT);
        exchange.setRouterAllowed(address(r2), true);
        bytes memory swapData =
            abi.encodeCall(MockRouter.doSwap, (address(fot), address(dst), received, address(exchange)));
        bytes memory bidData = abi.encode(OUT, address(r2), swapData);
        exchange.swap(address(fot), address(dst), AMOUNT_IN, OUT, "", bidData, keeper);
        assertEq(dst.balanceOf(address(exchange)), 0, "all dst forwarded");
        assertEq(fot.balanceOf(address(exchange)), 0, "no src stranded");
    }
}

/** Fee-on-transfer token: burns 10% of every transfer. */
contract FeeToken is ERC20 {
    constructor() ERC20("fot", "FOT") {}

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = amount / 10;
        super._transfer(from, to, amount - fee);
        if (fee > 0) super._transfer(from, address(0xdead), fee);
    }
}
