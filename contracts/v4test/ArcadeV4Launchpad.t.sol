// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ArcadeV4Launchpad} from "../v4src/ArcadeV4Launchpad.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {
    IHooks,
    IPoolManager,
    Currency,
    PoolKey,
    SwapParams,
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary
} from "../v4src/interfaces/IUniswapV4Types.sol";

/// @notice Tiny ERC20 used as the test USDC. Mintable so the test can fund
///         the creator wallet.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @notice Captures `take` calls so the hook side of the integration can be
///         asserted. Same shape as the mock used in the hook unit tests.
contract MockPoolManager is IPoolManager {
    Currency public lastCurrency;
    address public lastTo;
    uint256 public lastAmount;

    function take(Currency currency, address to, uint256 amount) external override {
        lastCurrency = currency;
        lastTo = to;
        lastAmount = amount;
    }
}

contract ArcadeV4LaunchpadTest is Test {
    MockUSDC usdc;
    MockPoolManager pm;
    ArcadeV4Launchpad lp;
    ArcadeAntiSniperHook hook;

    address constant TREASURY = address(0xBEEF);
    address constant CREATOR = address(0xC0DE);

    function setUp() public {
        usdc = new MockUSDC();
        pm = new MockPoolManager();
        lp = new ArcadeV4Launchpad(
            IERC20(address(usdc)),
            IPoolManager(address(pm)),
            address(0), // hook address - filled in below
            TREASURY
        );
        // The hook reads the launchpad address for snipe config + treasury.
        hook = new ArcadeAntiSniperHook(
            IPoolManager(address(pm)),
            lp,
            Currency.wrap(address(usdc))
        );
        // Fund + approve creation fee.
        usdc.mint(CREATOR, 100e6);
        vm.prank(CREATOR);
        usdc.approve(address(lp), type(uint256).max);
    }

    // --- createLaunch -----------------------------------------------------

    function test_createLaunch_charges3Usdc_andDeploysToken() public {
        uint256 treBefore = usdc.balanceOf(TREASURY);
        uint256 creatorBefore = usdc.balanceOf(CREATOR);

        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "ipfs://meta", 500, 30 minutes);

        // Treasury collected the 3 USDC fee; creator's balance dropped by it.
        assertEq(usdc.balanceOf(TREASURY) - treBefore, lp.CREATION_FEE(), "treasury fee");
        assertEq(creatorBefore - usdc.balanceOf(CREATOR), lp.CREATION_FEE(), "creator paid");

        // Token deployed with the canonical 1 B supply, sitting in the
        // launchpad until pool-init transfers it to the V4 pool.
        ArcadeV4Launchpad.Launch memory l = lp.getLaunch(token);
        assertEq(l.token, token, "token registered");
        assertEq(l.creator, CREATOR, "creator stored");
        assertEq(l.snipeStartBps, 500);
        assertEq(l.snipeDecaySeconds, uint32(30 minutes));
        assertEq(l.launchedAt, uint64(block.timestamp));
        assertEq(IERC20(token).balanceOf(address(lp)), lp.TOTAL_SUPPLY(), "launchpad holds supply");
        assertEq(lp.tokensCount(), 1);
    }

    function test_createLaunch_emptyName_reverts() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.EmptyName.selector);
        lp.createLaunch("", "TEST", "", 0, 0);
    }

    function test_createLaunch_snipeBpsOverCap_reverts() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.InvalidSnipeBps.selector);
        lp.createLaunch("Test", "TEST", "", 5_001, 30 minutes);
    }

    function test_createLaunch_snipeWithoutDecay_reverts() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.InvalidDecaySeconds.selector);
        lp.createLaunch("Test", "TEST", "", 500, 0);
    }

    function test_createLaunch_withoutSnipe_isAllowed() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0);
        ArcadeV4Launchpad.Launch memory l = lp.getLaunch(token);
        assertEq(l.snipeStartBps, 0);
        // currentSnipeBps must return 0 - the hook will no-op for this token.
        assertEq(lp.currentSnipeBps(token), 0);
    }

    // --- currentSnipeBps decay math --------------------------------------

    function test_currentSnipeBps_decaysLinearlyToZero() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 1_000, 100 seconds);
        // Read launchedAt straight from the contract to avoid any timing
        // drift between the test's `block.timestamp` snapshot and what was
        // actually recorded during the createLaunch call.
        ArcadeV4Launchpad.Launch memory l = lp.getLaunch(token);
        uint256 launchedAt = l.launchedAt;

        // At launch: full bps.
        assertEq(lp.currentSnipeBps(token), 1_000);

        // Quarter way through (25s elapsed): 75% remaining.
        vm.warp(launchedAt + 25);
        assertEq(lp.currentSnipeBps(token), 750);

        // Halfway (50s elapsed): 50%.
        vm.warp(launchedAt + 50);
        assertEq(lp.currentSnipeBps(token), 500);

        // After full window: 0.
        vm.warp(launchedAt + 200);
        assertEq(lp.currentSnipeBps(token), 0);
    }

    function test_treasury_isReturnedToHook() public view {
        assertEq(lp.treasury(), TREASURY);
    }

    // --- Hook integration ------------------------------------------------

    function test_hook_readsCurrentSnipeBpsFromLaunchpad() public {
        // Launch a token with 5% snipe tax.
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 500, 30 minutes);

        // Build a PoolKey where USDC + token are paired. Canonical order:
        // currency0 is the lower address.
        (address c0, address c1) =
            address(usdc) < token ? (address(usdc), token) : (token, address(usdc));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: lp.POOL_FEE(),
            tickSpacing: lp.TICK_SPACING(),
            hooks: address(hook)
        });

        // Determine the BUY direction relative to USDC's position in the key.
        bool zeroForOne = c0 == address(usdc);
        SwapParams memory p = SwapParams({zeroForOne: zeroForOne, amountSpecified: 10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        hook.beforeSwap(address(0xA), key, p, "");

        // 5% of 10_000 = 500 USDC skimmed to treasury.
        assertEq(pm.lastAmount(), 500, "skim 5%");
        assertEq(pm.lastTo(), TREASURY, "to launchpad treasury");
    }

    function test_hook_skipsTokenWithoutSnipeConfig() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0);

        (address c0, address c1) =
            address(usdc) < token ? (address(usdc), token) : (token, address(usdc));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: lp.POOL_FEE(),
            tickSpacing: lp.TICK_SPACING(),
            hooks: address(hook)
        });
        bool zeroForOne = c0 == address(usdc);
        SwapParams memory p = SwapParams({zeroForOne: zeroForOne, amountSpecified: 10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        hook.beforeSwap(address(0xA), key, p, "");

        assertEq(pm.lastAmount(), 0, "no skim when snipe disabled");
    }

    function test_hook_skimDecaysOverTime() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 1_000, 100 seconds);

        (address c0, address c1) =
            address(usdc) < token ? (address(usdc), token) : (token, address(usdc));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: lp.POOL_FEE(),
            tickSpacing: lp.TICK_SPACING(),
            hooks: address(hook)
        });
        bool zeroForOne = c0 == address(usdc);
        SwapParams memory p = SwapParams({zeroForOne: zeroForOne, amountSpecified: 10_000, sqrtPriceLimitX96: 0});

        // At launch: 10% of 10_000 = 1_000.
        vm.prank(address(pm));
        hook.beforeSwap(address(0xA), key, p, "");
        assertEq(pm.lastAmount(), 1_000, "skim at launch");

        // Half-window in: 5%.
        vm.warp(block.timestamp + 50);
        vm.prank(address(pm));
        hook.beforeSwap(address(0xA), key, p, "");
        assertEq(pm.lastAmount(), 500, "skim halfway");

        // After window: 0.
        vm.warp(block.timestamp + 100);
        vm.prank(address(pm));
        hook.beforeSwap(address(0xA), key, p, "");
        // lastAmount stays at the previous value because no take was called.
        // We assert the BeforeSwapDelta is zero instead.
        vm.prank(address(pm));
        (, BeforeSwapDelta delta, ) = hook.beforeSwap(address(0xA), key, p, "");
        assertEq(BeforeSwapDeltaLibrary.specifiedDelta(delta), 0, "no delta after decay");
    }
}
