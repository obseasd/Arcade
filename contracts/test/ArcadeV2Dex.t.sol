// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {IArcadeV2Pair} from "../src/dex/interfaces/IArcadeV2Pair.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

contract ArcadeV2DexTest is Test {
    MockUSDC usdc;
    MockToken tkn;
    ArcadeV2Factory factory;
    ArcadeV2Router router;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        usdc = new MockUSDC();
        tkn = new MockToken("Token", "TKN");
        factory = new ArcadeV2Factory(address(this));
        router = new ArcadeV2Router(address(factory));

        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 100_000e6);
        tkn.transfer(alice, 1_000_000e18);
        tkn.transfer(bob, 100e18);
    }

    function test_addLiquidity_and_swap() public {
        // Alice provides liquidity 100k USDC + 1M tokens (=> price 0.1 USDC/token)
        vm.startPrank(alice);
        usdc.approve(address(router), type(uint256).max);
        tkn.approve(address(router), type(uint256).max);
        (,, uint256 liq) =
            router.addLiquidity(address(usdc), address(tkn), 100_000e6, 1_000_000e18, 0, 0, alice, block.timestamp + 60);
        assertGt(liq, 0, "got LP");
        vm.stopPrank();

        // Bob swaps 10 USDC → TKN
        vm.startPrank(bob);
        usdc.approve(address(router), type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = address(tkn);
        uint256[] memory expected = router.getAmountsOut(10e6, path);
        router.swapExactTokensForTokens(10e6, expected[1] * 99 / 100, path, bob, block.timestamp + 60);
        assertGt(tkn.balanceOf(bob), 100e18, "bob has more tokens");
        vm.stopPrank();
    }

    function test_removeLiquidity_returnsBothSides() public {
        vm.startPrank(alice);
        usdc.approve(address(router), type(uint256).max);
        tkn.approve(address(router), type(uint256).max);
        (,, uint256 liq) =
            router.addLiquidity(address(usdc), address(tkn), 10_000e6, 100_000e18, 0, 0, alice, block.timestamp + 60);

        address pair = factory.getPair(address(usdc), address(tkn));
        IArcadeV2Pair(pair).approve(address(router), type(uint256).max);
        (uint256 a, uint256 b) =
            router.removeLiquidity(address(usdc), address(tkn), liq, 0, 0, alice, block.timestamp + 60);
        assertGt(a, 0);
        assertGt(b, 0);
        vm.stopPrank();
    }
}
