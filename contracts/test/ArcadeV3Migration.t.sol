// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
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

interface IV3Quoter {
    function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        external
        returns (uint256);
}

/**
 * @notice End-to-end test of the CLANKER_V3 true-Clanker launch: no bonding
 * curve, full supply locked single-sided in a V3 pool at creation, tradeable
 * immediately. Deploys the real V3 core Factory + our 0.7.6 locker, router and
 * quoter from the out-v3 artifacts.
 *
 * Prerequisite: `FOUNDRY_PROFILE=v3 forge build`.
 */
contract ArcadeV3MigrationTest is Test {
    MockUSDC usdc;
    ArcadeV2Factory v2Factory;
    ArcadeV2Router v2Router;
    ArcadeLaunchpad launchpad;
    address v3Factory;
    address v3Locker;
    address v3Router;
    address v3Quoter;

    address treasury = address(0xBEEF);
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);

    uint24 constant FEE = 10_000;

    function setUp() public {
        usdc = new MockUSDC();
        v2Factory = new ArcadeV2Factory(address(this));
        v2Router = new ArcadeV2Router(address(v2Factory));

        v3Factory = _deploy("out-v3/UniswapV3Factory.sol/UniswapV3Factory.json", "");
        launchpad = new ArcadeLaunchpad(
            IERC20(address(usdc)), v2Factory, address(v2Router), treasury, IArcadeV3Factory(v3Factory)
        );
        v3Locker = _deploy(
            "out-v3/ArcadeV3Locker.sol/ArcadeV3Locker.json", abi.encode(address(launchpad), v3Factory)
        );
        launchpad.setV3Locker(v3Locker);
        v3Router = _deploy(
            "out-v3/ArcadeV3SwapRouter.sol/ArcadeV3SwapRouter.json", abi.encode(v3Factory, address(usdc))
        );
        v3Quoter = _deploy(
            "out-v3/ArcadeV3Quoter.sol/ArcadeV3Quoter.json", abi.encode(v3Factory, address(usdc))
        );

        usdc.mint(creator, 1_000e6);
        usdc.mint(alice, 1_000_000e6);
    }

    function _deploy(string memory path, bytes memory args) internal returns (address addr) {
        bytes memory code = abi.encodePacked(vm.getCode(path), args);
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "deploy failed");
    }

    function _createV3Token() internal returns (address token, address pool) {
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        token = launchpad.createToken(
            "Vault Cat", "VCAT", "ipfs://x", IArcadeLaunchpad.LaunchMode.CLANKER_V3, address(0), 0
        );
        vm.stopPrank();
        pool = IArcadeV3Factory(v3Factory).getPool(address(usdc), token, FEE);
    }

    function test_launchesImmediatelySingleSided() public {
        (address token, address pool) = _createV3Token();

        ArcadeLaunchpad.TokenState memory s = launchpad.getTokenState(token);
        assertTrue(s.migrated, "flagged migrated from birth");
        assertEq(s.v2Pair, pool, "pool stored");
        assertTrue(pool != address(0), "pool created");

        // Single-sided: pool holds (almost) all the token and ZERO USDC.
        assertGt(IERC20(token).balanceOf(pool), 900_000_000e18, "pool holds the supply");
        assertEq(usdc.balanceOf(pool), 0, "no USDC at launch");
        // Active liquidity at the current tick is 0 at launch: the position
        // sits in a range above the start price (single-sided), so it only
        // becomes active once the first buy pushes the price into the range.
        assertEq(IArcadeV3Pool(pool).liquidity(), 0, "no active liquidity until first buy");

        assertEq(IArcadeV3Locker(v3Locker).positionIdByToken(token), 1, "position registered");

        // First buy activates the position's liquidity.
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(address(usdc), token, FEE, alice, 1_000e6, 0, block.timestamp + 60);
        vm.stopPrank();
        assertGt(IArcadeV3Pool(pool).liquidity(), 0, "liquidity active after first buy");
    }

    function test_buyViaRouter_thenCollectFees_splits80_20() public {
        (address token,) = _createV3Token();
        uint256 positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);

        // Alice buys the token with USDC through the V3 router.
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(
            address(usdc), token, FEE, alice, 10_000e6, 0, block.timestamp + 60
        );
        assertGt(got, 0, "received tokens");
        // Sell part back to also accrue token-side fees.
        IERC20(token).approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(token, address(usdc), FEE, alice, got / 2, 0, block.timestamp + 60);
        vm.stopPrank();

        uint256 cUsdc0 = usdc.balanceOf(creator);
        uint256 tUsdc0 = usdc.balanceOf(treasury);
        uint256 cTok0 = IERC20(token).balanceOf(creator);
        uint256 tTok0 = IERC20(token).balanceOf(treasury);

        (uint256 amt0, uint256 amt1) = IArcadeV3Locker(v3Locker).collectFees(positionId);
        assertTrue(amt0 > 0 || amt1 > 0, "some fees collected");

        // USDC-side fees split 80/20.
        uint256 cUsdcGain = usdc.balanceOf(creator) - cUsdc0;
        uint256 tUsdcGain = usdc.balanceOf(treasury) - tUsdc0;
        uint256 usdcFees = cUsdcGain + tUsdcGain;
        if (usdcFees > 0) {
            assertApproxEqAbs(cUsdcGain, (usdcFees * 8000) / 10000, 1, "creator 80% USDC");
        }
        // Token-side fees split 80/20.
        uint256 cTokGain = IERC20(token).balanceOf(creator) - cTok0;
        uint256 tTokGain = IERC20(token).balanceOf(treasury) - tTok0;
        uint256 tokFees = cTokGain + tTokGain;
        if (tokFees > 0) {
            assertApproxEqAbs(cTokGain, (tokFees * 8000) / 10000, 1, "creator 80% token");
        }
    }

    function test_quoterMatchesRouter() public {
        (address token,) = _createV3Token();

        uint256 quoted = IV3Quoter(v3Quoter).quoteExactInputSingle(address(usdc), token, FEE, 5_000e6);

        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(
            address(usdc), token, FEE, alice, 5_000e6, 0, block.timestamp + 60
        );
        vm.stopPrank();

        assertEq(got, quoted, "quote matches actual swap");
    }

    function test_principalStaysLocked() public {
        (address token, address pool) = _createV3Token();
        uint256 positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);

        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(address(usdc), token, FEE, alice, 5_000e6, 0, block.timestamp + 60);
        vm.stopPrank();

        uint128 liqBefore = IArcadeV3Pool(pool).liquidity();
        IArcadeV3Locker(v3Locker).collectFees(positionId);
        assertEq(IArcadeV3Pool(pool).liquidity(), liqBefore, "liquidity unchanged after collect");
    }

    function test_clankerV3_buyOnCurveReverts() public {
        (address token,) = _createV3Token();
        // No bonding curve — buy() must revert (already migrated from birth).
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        vm.expectRevert(ArcadeLaunchpad.AlreadyMigrated.selector);
        launchpad.buy(token, 100e6, 0);
        vm.stopPrank();
    }
}
