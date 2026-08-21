// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcadeSwapFeeRouter} from "../src/swap/ArcadeSwapFeeRouter.sol";

contract Mock20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Simulates a DEX venue router: pulls `amountIn` of tokenIn from the caller
/// (the FeeRouter, which approved it) and sends `outAmount` of tokenOut to
/// `recipient`. `outAmount` is set per-call so tests can exercise minOut.
contract MockVenueRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 outAmount, address recipient) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(recipient, outAmount);
    }
}

contract ArcadeSwapFeeRouterTest is Test {
    ArcadeSwapFeeRouter feeRouter;
    MockVenueRouter venue;
    Mock20 usdc; // input (a "base" here just as the paying token)
    Mock20 memecoin; // external token being bought

    address constant OWNER = address(0x0bDE);
    address constant TREASURY = address(0x7EEA);
    address constant TRADER = address(0x74ADE4);

    event Swapped(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 fee,
        uint256 amountOut,
        address router
    );

    function setUp() public {
        venue = new MockVenueRouter();
        usdc = new Mock20("USD Coin", "USDC");
        memecoin = new Mock20("Meme", "MEME");

        address[] memory routers = new address[](1);
        routers[0] = address(venue);
        feeRouter = new ArcadeSwapFeeRouter(OWNER, TREASURY, 50, routers); // 0.5%

        usdc.mint(TRADER, 1_000_000e6);
        memecoin.mint(address(venue), 1_000_000_000e18); // venue's inventory to pay out
        vm.prank(TRADER);
        usdc.approve(address(feeRouter), type(uint256).max);
    }

    // Helper: build the venue calldata for a net-in -> outAmount swap.
    function _data(uint256 net, uint256 outAmount) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            MockVenueRouter.swap.selector, address(usdc), address(memecoin), net, outAmount, address(feeRouter)
        );
    }

    // ---- happy path ----------------------------------------------------

    function test_swap_takesFeeAndForwards() public {
        uint256 amountIn = 10_000e6;
        uint256 fee = (amountIn * 50) / 10_000; // 0.5% = 50 USDC
        uint256 net = amountIn - fee;
        uint256 outAmount = 1_234e18;

        vm.expectEmit(true, true, true, true, address(feeRouter));
        emit Swapped(TRADER, address(usdc), address(memecoin), amountIn, fee, outAmount, address(venue));

        vm.prank(TRADER);
        uint256 got = feeRouter.swap(address(usdc), address(memecoin), amountIn, outAmount, 50, address(venue), _data(net, outAmount));

        assertEq(got, outAmount, "trader received the whole output");
        assertEq(memecoin.balanceOf(TRADER), outAmount, "trader got memecoin");
        assertEq(usdc.balanceOf(TREASURY), fee, "treasury got the 0.5% fee");
        assertEq(usdc.balanceOf(address(feeRouter)), 0, "no input dust in the router");
        assertEq(memecoin.balanceOf(address(feeRouter)), 0, "no output dust in the router");
        assertEq(usdc.allowance(address(feeRouter), address(venue)), 0, "residual approval zeroed");
    }

    function test_swap_feeMathExact() public {
        uint256 amountIn = 7_777e6;
        uint256 fee = (amountIn * 50) / 10_000;
        uint256 net = amountIn - fee;
        vm.prank(TRADER);
        feeRouter.swap(address(usdc), address(memecoin), amountIn, 1e18, 50, address(venue), _data(net, 1e18));
        assertEq(usdc.balanceOf(TREASURY), fee, "exact 0.5% fee");
    }

    function test_swap_zeroFeeWhenFeeBpsZero() public {
        vm.prank(OWNER);
        feeRouter.setFeeBps(0);
        uint256 amountIn = 10_000e6;
        vm.prank(TRADER);
        feeRouter.swap(address(usdc), address(memecoin), amountIn, 1e18, 50, address(venue), _data(amountIn, 1e18));
        assertEq(usdc.balanceOf(TREASURY), 0, "no fee at 0 bps");
    }

    // ---- protections ---------------------------------------------------

    function test_swap_revertsRouterNotAllowed() public {
        MockVenueRouter rogue = new MockVenueRouter();
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(ArcadeSwapFeeRouter.RouterNotAllowed.selector, address(rogue)));
        feeRouter.swap(address(usdc), address(memecoin), 1e6, 0, 50, address(rogue), _data(1e6, 1e18));
    }

    function test_swap_enforcesMinOut() public {
        uint256 amountIn = 10_000e6;
        uint256 net = amountIn - (amountIn * 50) / 10_000;
        uint256 outAmount = 100e18;
        // Trader demands 200 but the venue only pays 100 -> revert.
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(ArcadeSwapFeeRouter.InsufficientOutput.selector, outAmount, 200e18));
        feeRouter.swap(address(usdc), address(memecoin), amountIn, 200e18, 50, address(venue), _data(net, outAmount));
    }

    function test_swap_revertsZeroAmount() public {
        vm.prank(TRADER);
        vm.expectRevert(ArcadeSwapFeeRouter.ZeroAmount.selector);
        feeRouter.swap(address(usdc), address(memecoin), 0, 0, 50, address(venue), _data(0, 0));
    }

    function test_swap_revertsZeroToken() public {
        vm.prank(TRADER);
        vm.expectRevert(ArcadeSwapFeeRouter.ZeroAddress.selector);
        feeRouter.swap(address(0), address(memecoin), 1e6, 0, 50, address(venue), _data(1e6, 1e18));
    }

    function test_swap_revertsSameToken() public {
        vm.prank(TRADER);
        vm.expectRevert(ArcadeSwapFeeRouter.SameToken.selector);
        feeRouter.swap(address(usdc), address(usdc), 1e6, 0, 50, address(venue), _data(1e6, 1e18));
    }

    function test_swap_revertsFeeExceedsMax() public {
        // feeBps is 50; trader pins max 10 -> revert.
        vm.prank(TRADER);
        vm.expectRevert(abi.encodeWithSelector(ArcadeSwapFeeRouter.FeeExceedsMax.selector, uint16(50), uint16(10)));
        feeRouter.swap(address(usdc), address(memecoin), 10_000e6, 0, 10, address(venue), _data(9_950e6, 1e18));
    }

    // ---- admin ---------------------------------------------------------

    function test_setFeeBps_onlyOwnerAndCap() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        feeRouter.setFeeBps(100);

        vm.prank(OWNER);
        vm.expectRevert(ArcadeSwapFeeRouter.FeeTooHigh.selector);
        feeRouter.setFeeBps(201); // > MAX_FEE_BPS (200)

        vm.prank(OWNER);
        feeRouter.setFeeBps(100);
        assertEq(feeRouter.feeBps(), 100);
    }

    function test_setTreasury_onlyOwnerNonZero() public {
        vm.prank(OWNER);
        vm.expectRevert(ArcadeSwapFeeRouter.ZeroAddress.selector);
        feeRouter.setTreasury(address(0));
        vm.prank(OWNER);
        feeRouter.setTreasury(address(0x1234));
        assertEq(feeRouter.treasury(), address(0x1234));
    }

    function test_setRouterAllowed_onlyOwner() public {
        address r2 = address(0x1202);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        feeRouter.setRouterAllowed(r2, true);
        vm.prank(OWNER);
        feeRouter.setRouterAllowed(r2, true);
        assertTrue(feeRouter.allowedRouter(r2));
    }

    function test_rescue_onlyOwner() public {
        usdc.mint(address(feeRouter), 5e6);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        feeRouter.rescue(IERC20(address(usdc)), TREASURY, 5e6);
        vm.prank(OWNER);
        feeRouter.rescue(IERC20(address(usdc)), TREASURY, 5e6);
        assertEq(usdc.balanceOf(TREASURY), 5e6);
    }

    function test_renounceOwnership_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert(ArcadeSwapFeeRouter.RenounceDisabled.selector);
        feeRouter.renounceOwnership();
    }

    function test_ownable2Step() public {
        address newOwner = address(0x0b2E);
        vm.prank(OWNER);
        feeRouter.transferOwnership(newOwner);
        assertEq(feeRouter.owner(), OWNER);
        vm.prank(newOwner);
        feeRouter.acceptOwnership();
        assertEq(feeRouter.owner(), newOwner);
    }

    function test_constructor_seedsState() public view {
        assertEq(feeRouter.owner(), OWNER);
        assertEq(feeRouter.treasury(), TREASURY);
        assertEq(feeRouter.feeBps(), 50);
        assertTrue(feeRouter.allowedRouter(address(venue)));
        assertEq(feeRouter.MAX_FEE_BPS(), 200);
    }
}
