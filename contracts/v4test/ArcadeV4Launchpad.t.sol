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
    IUnlockCallback,
    Currency,
    PoolKey,
    SwapParams,
    ModifyLiquidityParams,
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    BalanceDelta
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

/// @notice Captures every relevant call so launchpad tests can assert the
///         full V4 sequence: initialize -> unlock -> modifyLiquidity ->
///         sync -> settle. Plus the hook's take path used by the swap tests.
contract MockPoolManager is IPoolManager {
    // --- take (hook path) ---
    Currency public lastCurrency;
    address public lastTo;
    uint256 public lastAmount;

    // --- initialize ---
    PoolKey public lastInitKey;
    uint160 public lastInitSqrt;
    bool public initialized;

    // --- unlock ---
    bytes public lastUnlockData;
    uint256 public unlockCount;

    // --- modifyLiquidity ---
    int24 public lastTickLower;
    int24 public lastTickUpper;
    int256 public lastLiquidityDelta;
    bytes32 public lastSalt;
    bool public modifyLiquidityCalled;

    // --- sync / settle ---
    Currency public lastSyncedCurrency;
    bool public syncCalled;
    bool public settleCalled;
    uint256 public settleReturn;

    function take(Currency currency, address to, uint256 amount) external override {
        lastCurrency = currency;
        lastTo = to;
        lastAmount = amount;
    }

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96)
        external
        override
        returns (int24)
    {
        lastInitKey = key;
        lastInitSqrt = sqrtPriceX96;
        initialized = true;
        return 0;
    }

    function unlock(bytes calldata data) external override returns (bytes memory) {
        lastUnlockData = data;
        unlockCount++;
        // Call back into the unlocker so the launchpad's modifyLiquidity +
        // settle sequence runs under our captured msg.sender check.
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function modifyLiquidity(
        PoolKey calldata,
        ModifyLiquidityParams calldata params,
        bytes calldata
    ) external override returns (BalanceDelta, BalanceDelta) {
        lastTickLower = params.tickLower;
        lastTickUpper = params.tickUpper;
        lastLiquidityDelta = params.liquidityDelta;
        lastSalt = params.salt;
        modifyLiquidityCalled = true;
        return (BalanceDelta.wrap(0), BalanceDelta.wrap(0));
    }

    function sync(Currency currency) external override {
        lastSyncedCurrency = currency;
        syncCalled = true;
    }

    function settle() external payable override returns (uint256) {
        settleCalled = true;
        return settleReturn;
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
        address token = lp.createLaunch("Test", "TEST", "ipfs://meta", 500, 30 minutes, 0);

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
        assertEq(l.creatorBps, 0, "no creator allocation");
        assertEq(IERC20(token).balanceOf(address(lp)), lp.TOTAL_SUPPLY(), "launchpad holds supply");
        assertEq(lp.tokensCount(), 1);
    }

    function test_createLaunch_emptyName_reverts() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.EmptyName.selector);
        lp.createLaunch("", "TEST", "", 0, 0, 0);
    }

    function test_createLaunch_snipeBpsOverCap_reverts() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.InvalidSnipeBps.selector);
        lp.createLaunch("Test", "TEST", "", 5_001, 30 minutes, 0);
    }

    function test_createLaunch_snipeWithoutDecay_reverts() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.InvalidDecaySeconds.selector);
        lp.createLaunch("Test", "TEST", "", 500, 0, 0);
    }

    function test_createLaunch_creatorBpsOverCap_reverts() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.InvalidCreatorBps.selector);
        lp.createLaunch("Test", "TEST", "", 0, 0, 1_001);
    }

    function test_createLaunch_withCreatorAllocation_sendsTokensToCreator() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0, 500); // 5%

        uint256 expected = (lp.TOTAL_SUPPLY() * 500) / 10_000;
        assertEq(IERC20(token).balanceOf(CREATOR), expected, "creator received allocation");
        assertEq(
            IERC20(token).balanceOf(address(lp)),
            lp.TOTAL_SUPPLY() - expected,
            "launchpad holds remainder"
        );
        ArcadeV4Launchpad.Launch memory l = lp.getLaunch(token);
        assertEq(l.creatorBps, 500);
    }

    function test_createLaunch_withoutSnipe_isAllowed() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0, 0);
        ArcadeV4Launchpad.Launch memory l = lp.getLaunch(token);
        assertEq(l.snipeStartBps, 0);
        // currentSnipeBps must return 0 - the hook will no-op for this token.
        assertEq(lp.currentSnipeBps(token), 0);
    }

    // --- currentSnipeBps decay math --------------------------------------

    function test_currentSnipeBps_decaysLinearlyToZero() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 1_000, 100 seconds, 0);
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
        address token = lp.createLaunch("Test", "TEST", "", 500, 30 minutes, 0);

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
        address token = lp.createLaunch("Test", "TEST", "", 0, 0, 0);

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

    // --- Pool initialization (unlock callback flow) ---------------------

    function test_initializePool_runsTheFullSequence() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 500, 30 minutes, 0);

        // Pick a starting sqrtPriceX96. The launchpad's _tickAtSqrtPriceApprox
        // returns -TICK_SPACING (-200) for any value below 2^96, and 0 at /
        // above 2^96. We pick a sub-2^96 value so the test exercises the
        // currency0/currency1 branch deterministically.
        uint160 sqrtPriceX96 = uint160(1 << 95); // < 2^96 → currentTick = -200
        int128 liquidityDelta = 1_000_000;

        vm.prank(CREATOR);
        lp.initializePool(token, sqrtPriceX96, liquidityDelta);

        // initialize() was called with the right PoolKey + price.
        assertTrue(pm.initialized(), "PM.initialize called");
        assertEq(pm.lastInitSqrt(), sqrtPriceX96);
        (Currency c0, Currency c1, uint24 fee, int24 spacing,) = pm.lastInitKey();
        // canonical sort
        (address e0, address e1) = address(usdc) < token
            ? (address(usdc), token)
            : (token, address(usdc));
        assertEq(Currency.unwrap(c0), e0, "currency0 canonical");
        assertEq(Currency.unwrap(c1), e1, "currency1 canonical");
        assertEq(fee, 10_000, "1% fee");
        assertEq(spacing, 200, "tick spacing 200");
        // hooks address isn't asserted because the test setUp wires the
        // launchpad with hook=0 (the hook is salt-mined after the launchpad
        // exists). Production deploys mine the salt first and pass the
        // predicted address into the launchpad constructor.
        assertEq(lp.HOOK(), address(0), "test setUp wired hook=0");

        // unlock() fired exactly once.
        assertEq(pm.unlockCount(), 1, "unlock called once");

        // modifyLiquidity inside the callback used a single-sided range and
        // the requested liquidityDelta. The exact tick bounds depend on
        // whether the launch token is currency0 or currency1.
        assertTrue(pm.modifyLiquidityCalled(), "modifyLiquidity called");
        assertEq(pm.lastLiquidityDelta(), int256(liquidityDelta));
        assertEq(pm.lastSalt(), bytes32(0));
        bool tokenIsC0 = address(token) < address(usdc);
        if (tokenIsC0) {
            // Above-current: lower bound just above currentTick, upper at max.
            // currentTick = -200, floor stays at -200, base = -200 + 200 = 0.
            assertEq(pm.lastTickLower(), int24(0));
            assertEq(pm.lastTickUpper(), int24((MAX_TICK_MATH() / 200) * 200));
        } else {
            // Below-current: lower at min, upper = floor(currentTick).
            assertEq(pm.lastTickLower(), int24(-(MAX_TICK_MATH() / 200) * 200));
            assertEq(pm.lastTickUpper(), int24(-200));
        }

        // sync + settle for the launch token: the launchpad transferred the
        // full TOTAL_SUPPLY to the PoolManager during the unlock callback.
        Currency expectedSync = tokenIsC0 ? c0 : c1;
        assertEq(Currency.unwrap(pm.lastSyncedCurrency()), Currency.unwrap(expectedSync));
        assertTrue(pm.syncCalled(), "sync called");
        assertTrue(pm.settleCalled(), "settle called");
        assertEq(IERC20(token).balanceOf(address(pm)), lp.TOTAL_SUPPLY());
        assertEq(IERC20(token).balanceOf(address(lp)), 0, "launchpad emptied of token");
    }

    function test_initializePool_revertsOnUnknownToken() public {
        vm.expectRevert(ArcadeV4Launchpad.UnknownToken.selector);
        lp.initializePool(address(0xDEAD), uint160(1 << 96), 1_000);
    }

    function test_initializePool_revertsOnZeroLiquidity() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0, 0);
        vm.expectRevert(ArcadeV4Launchpad.ZeroLiquidity.selector);
        lp.initializePool(token, uint160(1 << 96), 0);
    }

    function test_initializePool_isIdempotent() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0, 0);
        vm.prank(CREATOR);
        lp.initializePool(token, uint160(1 << 96), 1_000);
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.PoolAlreadyInitialized.selector);
        lp.initializePool(token, uint160(1 << 96), 1_000);
    }

    function test_initializePool_withCreatorAllocation_locksRemainder() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0, 250); // 2.5%

        uint256 creatorShare = (lp.TOTAL_SUPPLY() * 250) / 10_000;
        uint256 poolShare = lp.TOTAL_SUPPLY() - creatorShare;

        vm.prank(CREATOR);
        lp.initializePool(token, uint160(1 << 95), 1_000_000);

        // The pool only got the remainder, not the full supply.
        assertEq(IERC20(token).balanceOf(address(pm)), poolShare, "pool gets remainder");
        assertEq(IERC20(token).balanceOf(CREATOR), creatorShare, "creator keeps allocation");
        assertEq(IERC20(token).balanceOf(address(lp)), 0, "launchpad fully drained");
    }

    function test_unlockCallback_onlyPoolManager() public {
        bytes memory data = abi.encode(address(0), uint160(0), int128(0));
        vm.expectRevert(ArcadeV4Launchpad.NotPoolManager.selector);
        lp.unlockCallback(data);
    }

    /// @dev Mirrors the V4 MAX_TICK constant the launchpad uses for the upper
    ///      bound. Kept inline to avoid importing private state from the
    ///      contract under test.
    function MAX_TICK_MATH() internal pure returns (int24) {
        return 887_272;
    }

    function test_hook_skimDecaysOverTime() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 1_000, 100 seconds, 0);

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
