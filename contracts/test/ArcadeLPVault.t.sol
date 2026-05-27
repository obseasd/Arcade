// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockV3PositionManager} from "./mocks/MockV3PositionManager.sol";
import {ArcadeLPVault} from "../src/launchpad/ArcadeLPVault.sol";
import {ArcadeV3PriceMath} from "../src/v3/ArcadeV3PriceMath.sol";
import {IArcadeV3PositionManager} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PriceMathHarness {
    function encode(uint256 a1, uint256 a0) external pure returns (uint160) {
        return ArcadeV3PriceMath.encodeSqrtPriceX96(a1, a0);
    }

    function ticks(int24 spacing) external pure returns (int24 lo, int24 hi) {
        return ArcadeV3PriceMath.fullRangeTicks(spacing);
    }
}

contract ArcadeLPVaultTest is Test {
    MockUSDC usdc;
    MockUSDC token; // stand-in launchpad token (18dp like the real one would be)
    MockV3PositionManager npm;
    ArcadeLPVault vault;
    PriceMathHarness math;

    address launchpad = address(0xABCDEF);
    address creator = address(0xC0FFEE);
    address treasury = address(0xBEEF);

    function setUp() public {
        usdc = new MockUSDC();
        token = new MockUSDC();
        npm = new MockV3PositionManager();
        // The vault treats `launchpad` as the only depositor.
        vault = new ArcadeLPVault(IArcadeV3PositionManager(address(npm)), launchpad);
        math = new PriceMathHarness();
    }

    function _vaultAPosition() internal returns (uint256 id) {
        // Launchpad mints a position then approves + deposits into the vault.
        id = npm.testMint(launchpad, address(usdc), address(token));
        vm.startPrank(launchpad);
        npm.approve(address(vault), id);
        vault.deposit(id, creator, treasury, vault.DEFAULT_CREATOR_BPS());
        vm.stopPrank();
    }

    function test_deposit_locksPositionInVault() public {
        uint256 id = _vaultAPosition();
        assertEq(npm.ownerOf(id), address(vault), "vault holds NFT");
        ArcadeLPVault.VaultedPosition memory p = vault.getPosition(id);
        assertTrue(p.exists);
        assertEq(p.creator, creator);
        assertEq(p.platform, treasury);
        assertEq(p.creatorBps, 8000);
        assertEq(vault.positionsCount(), 1);
    }

    function test_deposit_onlyLaunchpad() public {
        uint256 id = npm.testMint(address(this), address(usdc), address(token));
        npm.approve(address(vault), id);
        vm.expectRevert(ArcadeLPVault.OnlyLaunchpad.selector);
        vault.deposit(id, creator, treasury, 8000);
    }

    function test_collectFees_splits80_20() public {
        uint256 id = _vaultAPosition();

        // Accrue fees: 1000 USDC (token0) + 500 token (token1), and fund the NPM.
        npm.testAccrueFees(id, 1_000e6, 500e6);
        usdc.mint(address(npm), 1_000e6);
        token.mint(address(npm), 500e6);

        vault.collectFees(id);

        // 80% creator / 20% treasury on each token.
        assertEq(usdc.balanceOf(creator), 800e6, "creator USDC 80%");
        assertEq(usdc.balanceOf(treasury), 200e6, "treasury USDC 20%");
        assertEq(token.balanceOf(creator), 400e6, "creator token 80%");
        assertEq(token.balanceOf(treasury), 100e6, "treasury token 20%");

        // Vault holds nothing afterwards.
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_collectFees_permissionless() public {
        uint256 id = _vaultAPosition();
        npm.testAccrueFees(id, 100e6, 0);
        usdc.mint(address(npm), 100e6);

        // A random address pokes collectFees — funds still go to creator/treasury.
        vm.prank(address(0xD00D));
        vault.collectFees(id);
        assertEq(usdc.balanceOf(creator), 80e6);
        assertEq(usdc.balanceOf(treasury), 20e6);
    }

    function test_collectFees_unknownPosition_reverts() public {
        vm.expectRevert(ArcadeLPVault.UnknownPosition.selector);
        vault.collectFees(999);
    }

    function test_vault_hasNoWayToWithdrawPrincipal() public {
        // Sanity: the vault exposes no decreaseLiquidity / transfer-out path.
        // This is enforced structurally (no such function), so we just assert
        // the only state-changing externals are deposit + collectFees here by
        // confirming the NFT stays put after a collect.
        uint256 id = _vaultAPosition();
        npm.testAccrueFees(id, 10e6, 0);
        usdc.mint(address(npm), 10e6);
        vault.collectFees(id);
        assertEq(npm.ownerOf(id), address(vault), "NFT never leaves the vault");
    }

    // ---- Price math ----

    function test_priceMath_equalReservesGives1to1() public view {
        // amount1 == amount0 => price 1.0 => sqrtPriceX96 == 2^96
        uint160 sp = math.encode(1e18, 1e18);
        assertEq(uint256(sp), 1 << 96, "sqrtPrice of 1.0 is 2^96");
    }

    function test_priceMath_4xPriceGives2xSqrt() public view {
        // price = amount1/amount0 = 4 => sqrt = 2 => sqrtPriceX96 = 2 * 2^96
        uint160 sp = math.encode(4e18, 1e18);
        assertApproxEqAbs(uint256(sp), 2 * (1 << 96), 2, "sqrt(4) = 2");
    }

    function test_priceMath_handlesAsymmetricDecimals() public view {
        // Typical migration: ~20000e6 USDC vs 200_000_000e18 tokens.
        // Just assert it doesn't revert and is within uint160.
        uint160 sp = math.encode(20_000e6, 200_000_000e18);
        assertGt(uint256(sp), 0);
        sp = math.encode(200_000_000e18, 20_000e6);
        assertGt(uint256(sp), 0);
    }

    function test_priceMath_fullRangeTicksAligned() public view {
        (int24 lo, int24 hi) = math.ticks(200); // 1% fee tier spacing
        assertEq(lo % 200, 0, "lower aligned");
        assertEq(hi % 200, 0, "upper aligned");
        assertEq(lo, -887200);
        assertEq(hi, 887200);
    }
}
