// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ArcadeV4Launchpad} from "../v4src/ArcadeV4Launchpad.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";

/// @notice Tiny ERC20 used as the test USDC. Mintable so the test can fund
///         the creator wallet.
contract MockUSDC is ERC20 {
    /// Simulates the real USDC blocklist: transfers TO a blocked address
    /// revert. Needed to exercise the CSEC-002 path (a blocklisted treasury
    /// must NOT be able to brick createLaunch, and a failed sweep must
    /// restore the pot). Defaults to false for every address, so existing
    /// tests are unaffected.
    mapping(address => bool) public blocked;

    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "USDC: recipient blocked");
        super._update(from, to, value);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @notice Captures every relevant call so launchpad tests can assert the
///         full V4 sequence: initialize -> unlock -> modifyLiquidity ->
///         sync -> settle. Plus the hook's take path used by the swap tests.
///         Duck-typed (no `is IPoolManager`) because the upstream interface
///         has 14+ methods and inherits from 4 base interfaces - tests cast
///         `IPoolManager(address(pm))` so Solidity doesn't ABI-check.
contract MockPoolManager {
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

    function take(Currency currency, address to, uint256 amount) external {
        lastCurrency = currency;
        lastTo = to;
        lastAmount = amount;
    }

    // Tick the mock claims the pool initialised at. Tests set this so the
    // launchpad's single-sided-range math runs against a known value.
    int24 public initialTick;

    function setInitialTick(int24 tick) external {
        initialTick = tick;
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        lastInitKey = key;
        lastInitSqrt = sqrtPriceX96;
        initialized = true;
        return initialTick;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        lastUnlockData = data;
        unlockCount++;
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function modifyLiquidity(PoolKey memory, ModifyLiquidityParams memory params, bytes calldata)
        external
        returns (BalanceDelta, BalanceDelta)
    {
        lastTickLower = params.tickLower;
        lastTickUpper = params.tickUpper;
        lastLiquidityDelta = params.liquidityDelta;
        lastSalt = params.salt;
        modifyLiquidityCalled = true;
        return (BalanceDelta.wrap(0), BalanceDelta.wrap(0));
    }

    function sync(Currency currency) external {
        lastSyncedCurrency = currency;
        syncCalled = true;
    }

    function settle() external payable returns (uint256) {
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
        // Bootstrap order matches production: deploy launchpad, then hook,
        // then wire setHook.
        lp = new ArcadeV4Launchpad(
            IERC20(address(usdc)),
            IPoolManager(address(pm)),
            TREASURY
        );
        hook = new ArcadeAntiSniperHook(
            IPoolManager(address(pm)),
            lp,
            Currency.wrap(address(usdc)),
            TREASURY
        );
        lp.setHook(address(hook));
        // Fund + approve creation fee.
        usdc.mint(CREATOR, 100e6);
        vm.prank(CREATOR);
        usdc.approve(address(lp), type(uint256).max);
    }

    // --- createLaunch -----------------------------------------------------

    // ===== CSEC-002: creation-fee pot / sweep / treasury rotation =====
    // The audit fix (hold the fee, sweep later) shipped with NO coverage.
    // These lock in every branch of it.

    function test_sweepCreationFees_movesPotToTreasury() public {
        vm.prank(CREATOR);
        lp.createLaunch("T", "T", "u", 0, 0, 0);

        uint256 treBefore = usdc.balanceOf(TREASURY);
        lp.sweepCreationFees();

        assertEq(usdc.balanceOf(TREASURY) - treBefore, lp.CREATION_FEE(), "treasury swept");
        assertEq(lp.pendingCreationFees(), 0, "pot drained");
        assertEq(usdc.balanceOf(address(lp)), 0, "launchpad holds nothing");
    }

    function test_sweepCreationFees_emptyPot_isNoop() public {
        uint256 treBefore = usdc.balanceOf(TREASURY);
        lp.sweepCreationFees(); // must not revert
        assertEq(usdc.balanceOf(TREASURY), treBefore, "no movement");
        assertEq(lp.pendingCreationFees(), 0);
    }

    function test_sweepCreationFees_afterRotation_paysNewTreasury() public {
        vm.prank(CREATOR);
        lp.createLaunch("T", "T", "u", 0, 0, 0);

        address newTre = address(0xFEED);
        vm.prank(address(this)); // this test contract is DEPLOYER
        lp.setTreasury(newTre);
        lp.sweepCreationFees();

        assertEq(usdc.balanceOf(newTre), lp.CREATION_FEE(), "new treasury paid");
        assertEq(usdc.balanceOf(TREASURY), 0, "old treasury not paid");
    }

    /// The whole point of CSEC-002: a blocklisted treasury must NOT brick
    /// createLaunch, and a failed sweep must RESTORE the pot (never leak it).
    function test_blocklistedTreasury_doesNotBrickCreate_andSweepRestoresPot() public {
        usdc.setBlocked(TREASURY, true);

        // createLaunch still works despite the treasury being blocked.
        vm.prank(CREATOR);
        lp.createLaunch("T", "T", "u", 0, 0, 0);
        assertEq(lp.pendingCreationFees(), lp.CREATION_FEE(), "fee still collected");

        // The sweep reverts, but the pot is restored for a later attempt.
        vm.expectRevert(ArcadeV4Launchpad.TreasuryTransferFailed.selector);
        lp.sweepCreationFees();
        assertEq(lp.pendingCreationFees(), lp.CREATION_FEE(), "pot restored, not leaked");

        // Rotate away from the blocked treasury -> sweep now succeeds.
        address newTre = address(0xFEED);
        lp.setTreasury(newTre);
        lp.sweepCreationFees();
        assertEq(usdc.balanceOf(newTre), lp.CREATION_FEE(), "recovered via rotation");
        assertEq(lp.pendingCreationFees(), 0, "pot drained");
    }

    function test_setTreasury_onlyDeployer() public {
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.NotDeployer.selector);
        lp.setTreasury(address(0xFEED));
    }

    function test_unsafeSweep_revertsOnExternalCall() public {
        vm.expectRevert(ArcadeV4Launchpad.NotSelfCall.selector);
        lp.unsafeSweep(CREATOR, 1);
    }

    function test_createLaunch_charges3Usdc_andDeploysToken() public {
        uint256 treBefore = usdc.balanceOf(TREASURY);
        uint256 creatorBefore = usdc.balanceOf(CREATOR);

        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "ipfs://meta", 500, 30 minutes, 0);

        // CSEC-002: the fee is HELD by the launchpad (not sent straight to
        // treasury, which a USDC blocklist could use to brick createLaunch).
        // Treasury only gets it on sweepCreationFees().
        assertEq(usdc.balanceOf(TREASURY) - treBefore, 0, "treasury not paid on create");
        assertEq(lp.pendingCreationFees(), lp.CREATION_FEE(), "fee pot credited");
        assertEq(usdc.balanceOf(address(lp)), lp.CREATION_FEE(), "launchpad holds fee");
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

    function test_treasury_publicGetter() public view {
        // The hook no longer reads this (audit fix #3 - hook caches its own
        // immutable TREASURY). Kept as a public getter for indexer convenience.
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
            hooks: IHooks(address(hook))
        });

        // Determine the BUY direction relative to USDC's position in the key.
        bool zeroForOne = c0 == address(usdc);
        SwapParams memory p = SwapParams({zeroForOne: zeroForOne, amountSpecified: -10_000, sqrtPriceLimitX96: 0});

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
            hooks: IHooks(address(hook))
        });
        bool zeroForOne = c0 == address(usdc);
        SwapParams memory p = SwapParams({zeroForOne: zeroForOne, amountSpecified: -10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        hook.beforeSwap(address(0xA), key, p, "");

        assertEq(pm.lastAmount(), 0, "no skim when snipe disabled");
    }

    // --- Pool initialization (unlock callback flow) ---------------------

    function test_initializePool_runsTheFullSequence() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 500, 30 minutes, 0);

        // Configure the mock to claim the pool initialised at tick -200.
        // This makes the single-sided-range math deterministic: with currency0
        // = token branch the range is (0, maxUsable]; with currency1 = token
        // branch the range is [-maxUsable, -200].
        pm.setInitialTick(int24(-200));
        uint160 sqrtPriceX96 = uint160(1 << 95);
        int128 liquidityDelta = 1_000_000;

        vm.prank(CREATOR);
        lp.initializePool(token, sqrtPriceX96, liquidityDelta);

        // initialize() was called with the right PoolKey + price.
        assertTrue(pm.initialized(), "PM.initialize called");
        assertEq(pm.lastInitSqrt(), sqrtPriceX96);
        (Currency c0, Currency c1, uint24 fee, int24 spacing, IHooks hooks) = pm.lastInitKey();
        (address e0, address e1) = address(usdc) < token
            ? (address(usdc), token)
            : (token, address(usdc));
        assertEq(Currency.unwrap(c0), e0, "currency0 canonical");
        assertEq(Currency.unwrap(c1), e1, "currency1 canonical");
        assertEq(fee, 10_000, "1% fee");
        assertEq(spacing, 200, "tick spacing 200");
        assertEq(address(hooks), address(hook), "hooks address piped from setHook");

        assertEq(pm.unlockCount(), 1, "unlock called once");
        assertTrue(pm.modifyLiquidityCalled(), "modifyLiquidity called");
        assertEq(pm.lastLiquidityDelta(), int256(liquidityDelta));
        assertEq(pm.lastSalt(), bytes32(0));
        bool tokenIsC0 = address(token) < address(usdc);
        if (tokenIsC0) {
            // Above-current: lower = floor(-200)+200 = 0; upper = maxUsable.
            assertEq(pm.lastTickLower(), int24(0));
            assertEq(pm.lastTickUpper(), int24((MAX_TICK_MATH() / 200) * 200));
        } else {
            // Below-current: lower = -maxUsable; upper = floor(-200) = -200.
            assertEq(pm.lastTickLower(), int24(-(MAX_TICK_MATH() / 200) * 200));
            assertEq(pm.lastTickUpper(), int24(-200));
        }

        // sync + settle for the launch token: the launchpad transferred its
        // balance (= TOTAL_SUPPLY here since creator allocation is 0) to the
        // PoolManager during the unlock callback.
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
        bytes memory data = abi.encode(address(0), int24(0), int128(0), uint160(0));
        vm.expectRevert(ArcadeV4Launchpad.NotPoolManager.selector);
        lp.unlockCallback(data);
    }

    // --- setHook one-shot wiring -----------------------------------------

    function test_setHook_revertsOnSecondCall() public {
        // setUp already called setHook once. A second call by anyone reverts.
        vm.expectRevert(ArcadeV4Launchpad.HookAlreadySet.selector);
        lp.setHook(address(0xBEEF));
    }

    function test_setHook_revertsForNonDeployer() public {
        // Fresh launchpad so HOOK starts unset.
        ArcadeV4Launchpad fresh = new ArcadeV4Launchpad(
            IERC20(address(usdc)), IPoolManager(address(pm)), TREASURY
        );
        vm.prank(address(0xBAD));
        vm.expectRevert(ArcadeV4Launchpad.NotDeployer.selector);
        fresh.setHook(address(0xBEEF));
    }

    function test_setHook_revertsOnZeroAddress() public {
        ArcadeV4Launchpad fresh = new ArcadeV4Launchpad(
            IERC20(address(usdc)), IPoolManager(address(pm)), TREASURY
        );
        vm.expectRevert(ArcadeV4Launchpad.ZeroAddress.selector);
        fresh.setHook(address(0));
    }

    // --- Audit #2: HOOK-must-be-set guards ------------------------------

    function test_createLaunch_revertsWhenHookUnset() public {
        // Fresh launchpad without setHook: createLaunch should refuse to
        // register anything (prevents the front-run path between deploy and
        // setHook, where someone could create a launch that would later be
        // initializePool'd with key.hooks = 0).
        ArcadeV4Launchpad fresh = new ArcadeV4Launchpad(
            IERC20(address(usdc)), IPoolManager(address(pm)), TREASURY
        );
        usdc.mint(CREATOR, 100e6);
        vm.prank(CREATOR);
        usdc.approve(address(fresh), type(uint256).max);
        vm.prank(CREATOR);
        vm.expectRevert(ArcadeV4Launchpad.HookNotSet.selector);
        fresh.createLaunch("Test", "TEST", "", 0, 0, 0);
    }

    function test_initializePool_revertsWhenHookUnset() public {
        // The wired test launchpad already has HOOK set, so to exercise the
        // initializePool guard we need a fresh launchpad. But createLaunch is
        // now guarded too, so we can't register a launch without setHook.
        // The guard is implicitly tested by createLaunch_revertsWhenHookUnset
        // (no launch can exist with HOOK=0). For completeness, verify the
        // error selector is wired in.
        ArcadeV4Launchpad fresh = new ArcadeV4Launchpad(
            IERC20(address(usdc)), IPoolManager(address(pm)), TREASURY
        );
        vm.expectRevert(ArcadeV4Launchpad.HookNotSet.selector);
        fresh.initializePool(address(0xDEAD), uint160(1 << 96), 1_000);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(ArcadeV4Launchpad.ZeroAddress.selector);
        new ArcadeV4Launchpad(IERC20(address(0)), IPoolManager(address(pm)), TREASURY);
        vm.expectRevert(ArcadeV4Launchpad.ZeroAddress.selector);
        new ArcadeV4Launchpad(IERC20(address(usdc)), IPoolManager(address(pm)), address(0));
    }

    // --- View helpers ----------------------------------------------------

    function test_previewPosition_returnsSingleSidedRange() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0, 0);

        (int24 tickLower, int24 tickUpper, bool tokenIsC0) =
            lp.previewPosition(token, int24(-200));

        assertEq(tokenIsC0, address(token) < address(usdc));
        if (tokenIsC0) {
            assertEq(tickLower, int24(0));
            assertEq(tickUpper, int24((MAX_TICK_MATH() / 200) * 200));
        } else {
            assertEq(tickLower, int24(-(MAX_TICK_MATH() / 200) * 200));
            assertEq(tickUpper, int24(-200));
        }
    }

    function test_previewPosition_revertsOnUnknownToken() public {
        vm.expectRevert(ArcadeV4Launchpad.UnknownToken.selector);
        lp.previewPosition(address(0xDEAD), int24(0));
    }

    function test_poolAllocation_reflectsCreatorDeduction() public {
        vm.prank(CREATOR);
        address token = lp.createLaunch("Test", "TEST", "", 0, 0, 300); // 3%
        uint256 expected = lp.TOTAL_SUPPLY() - (lp.TOTAL_SUPPLY() * 300) / 10_000;
        assertEq(lp.poolAllocation(token), expected);
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
            hooks: IHooks(address(hook))
        });
        bool zeroForOne = c0 == address(usdc);
        SwapParams memory p = SwapParams({zeroForOne: zeroForOne, amountSpecified: -10_000, sqrtPriceLimitX96: 0});

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
        assertEq(BeforeSwapDeltaLibrary.getSpecifiedDelta(delta), 0, "no delta after decay");
    }
}
