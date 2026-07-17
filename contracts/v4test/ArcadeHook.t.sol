// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {ArcadeHook} from "../v4src/ArcadeHook.sol";
import {ArcadeV4Curve} from "../v4src/libraries/ArcadeV4Curve.sol";

import {PoolManager} from "v4-core/PoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TestERC20} from "v4-core/test/TestERC20.sol";

/**
 * @title ArcadeHookTest
 * @notice Foundation-pass tests (V4 Phase 2 Round 2). The hook does NOT yet
 *         implement curve math, graduation, royalty, or locked-LP minting;
 *         those land in Rounds 3-5 with their own integration suites.
 *
 *         This suite verifies the surface contract:
 *           - Permission bitmap is exactly 0x3EEC.
 *           - Constructor rejects zero addresses for everything except
 *             twitterEscrow (which is allowed to be zero pre-bootstrap).
 *           - createLaunch pulls 3 USDC, deploys an ArcadeLaunchToken with
 *             1 B supply, registers it, and emits TokenLaunched.
 *           - Owner controls (pause, setTreasury, setTwitterEscrow).
 *           - Unused IHooks slots revert HookNotImplemented.
 *           - Used-but-stubbed callbacks return their selector (do not revert)
 *             so a basic V4 swap flow can be wired in Round 3 without surgery
 *             on this file.
 *           - currentSnipeBps decays linearly and is bounded by [0, startBps].
 */
contract ArcadeHookTest is Test {
    ArcadeHook hook;
    PoolManager pm;
    TestERC20 usdc;

    address poolManagerAddr;
    address constant LOCKED_VAULT = address(0xCAFE);
    address constant TREASURY = address(0xBEEF);
    address constant ESCROW = address(0xE5C);
    address constant OWNER = address(0x0123);
    address constant ALICE = address(0xA11CE);

    /// @dev Permission bitmap from the spec: 10 callbacks claimed.
    uint160 internal constant TARGET_FLAGS = uint160(0x3ECE);

    function setUp() public {
        pm = new PoolManager(address(this));
        poolManagerAddr = address(pm);
        usdc = new TestERC20(0);

        // Deploy the hook at an address whose low 14 bits encode our claimed
        // permissions. PoolManager validates this on every callback dispatch.
        // We pick a fixed high-bit prefix so the address is deterministic per
        // run and easy to assert in failure messages.
        address hookAddr = address(uint160(0xCAFE0000 | TARGET_FLAGS));
        deployCodeTo(
            "ArcadeHook.sol:ArcadeHook",
            abi.encode(IPoolManager(poolManagerAddr), Currency.wrap(address(usdc)), LOCKED_VAULT, TREASURY, ESCROW, OWNER),
            hookAddr
        );
        hook = ArcadeHook(hookAddr);
    }

    // -------------------------------------------------------------------
    // Permissions
    // -------------------------------------------------------------------

    function test_getHookPermissions_isExactly0x3ECE() public view {
        uint160 expected = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
        // 10 bits set: 1, 2, 3, 6, 7, 9, 10, 11, 12, 13 = 0x3ECE = 16078.
        // V4_HOOK_SPEC.md Section 3 originally wrote "0x3EEC" which is a typo;
        // 0x3EEC encodes bits {2,3,5,6,7,9,10,11,12,13} = bit 5 set, bit 1 unset
        // = BEFORE_DONATE on, AFTER_ADD_LIQ_RETURNS_DELTA off. That contradicts
        // the spec's own permission table. The hook + this test track the
        // table, not the typo.
        assertEq(expected, 0x3ECE, "spec drift: bitmap != 0x3ECE");
        assertEq(hook.getHookPermissions(), expected, "hook flags must match spec table");
    }

    // -------------------------------------------------------------------
    // Constructor invariants
    // -------------------------------------------------------------------

    function test_constructor_rejectsZeroPoolManager() public {
        vm.expectRevert(ArcadeHook.ZeroAddress.selector);
        new ArcadeHook(
            IPoolManager(address(0)), Currency.wrap(address(usdc)), LOCKED_VAULT, TREASURY, ESCROW, OWNER
        );
    }

    function test_constructor_rejectsZeroUsdc() public {
        vm.expectRevert(ArcadeHook.ZeroAddress.selector);
        new ArcadeHook(IPoolManager(poolManagerAddr), Currency.wrap(address(0)), LOCKED_VAULT, TREASURY, ESCROW, OWNER);
    }

    function test_constructor_rejectsZeroLockedVault() public {
        vm.expectRevert(ArcadeHook.ZeroAddress.selector);
        new ArcadeHook(IPoolManager(poolManagerAddr), Currency.wrap(address(usdc)), address(0), TREASURY, ESCROW, OWNER);
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(ArcadeHook.ZeroAddress.selector);
        new ArcadeHook(IPoolManager(poolManagerAddr), Currency.wrap(address(usdc)), LOCKED_VAULT, address(0), ESCROW, OWNER);
    }

    function test_constructor_allowsZeroTwitterEscrow() public {
        // Escrow may be zero at bootstrap; admin wires it in later.
        ArcadeHook h = new ArcadeHook(
            IPoolManager(poolManagerAddr), Currency.wrap(address(usdc)), LOCKED_VAULT, TREASURY, address(0), OWNER
        );
        assertEq(h.twitterEscrow(), address(0), "escrow allowed zero at init");
    }

    function test_constructor_setsImmutables() public view {
        assertEq(address(hook.POOL_MANAGER()), poolManagerAddr, "POOL_MANAGER");
        assertEq(Currency.unwrap(hook.USDC()), address(usdc), "USDC");
        assertEq(hook.LOCKED_VAULT(), LOCKED_VAULT, "LOCKED_VAULT");
        assertEq(hook.TREASURY(), TREASURY, "TREASURY");
        assertEq(hook.twitterEscrow(), ESCROW, "twitterEscrow");
        assertEq(hook.owner(), OWNER, "owner");
    }

    // -------------------------------------------------------------------
    // createLaunch
    // -------------------------------------------------------------------

    function test_createLaunch_pullsCreationFeeAndDeploysToken() public {
        usdc.mint(ALICE, 100e6);
        vm.startPrank(ALICE);
        usdc.approve(address(hook), type(uint256).max);
        uint256 treasuryBefore = usdc.balanceOf(TREASURY);
        (address tokenAddr,) = hook.createLaunch(
            "Demo", "DEMO", "ipfs://demo", 0, address(0), 0, 0, 0
        );
        vm.stopPrank();

        assertGt(uint160(tokenAddr), 0, "token deployed");
        assertEq(usdc.balanceOf(TREASURY) - treasuryBefore, 3e6, "3 USDC fee pulled");
        assertTrue(hook.registeredLaunches(tokenAddr), "token registered");
        assertEq(hook.tokensCount(), 1, "registry incremented");
    }

    function test_createLaunch_revertsOnEmptyName() public {
        usdc.mint(ALICE, 100e6);
        vm.prank(ALICE);
        usdc.approve(address(hook), type(uint256).max);

        vm.prank(ALICE);
        vm.expectRevert(ArcadeHook.EmptyName.selector);
        hook.createLaunch("", "DEMO", "ipfs://demo", 0, address(0), 0, 0, 0);

        vm.prank(ALICE);
        vm.expectRevert(ArcadeHook.EmptyName.selector);
        hook.createLaunch("Demo", "", "ipfs://demo", 0, address(0), 0, 0, 0);
    }

    function test_createLaunch_revertsOnInvalidMode() public {
        usdc.mint(ALICE, 100e6);
        vm.startPrank(ALICE);
        usdc.approve(address(hook), type(uint256).max);
        vm.expectRevert(ArcadeHook.InvalidMode.selector);
        hook.createLaunch("Demo", "DEMO", "ipfs://demo", 3, address(0), 0, 0, 0);
        vm.stopPrank();
    }

    function test_createLaunch_revertsOnHighSnipeBps() public {
        usdc.mint(ALICE, 100e6);
        vm.startPrank(ALICE);
        usdc.approve(address(hook), type(uint256).max);
        vm.expectRevert(ArcadeHook.InvalidSnipeBps.selector);
        // 6000 bps > MAX_SNIPE_START_BPS (5000)
        hook.createLaunch("Demo", "DEMO", "ipfs://demo", 0, address(0), 0, 6_000, 600);
        vm.stopPrank();
    }

    function test_createLaunch_revertsOnSnipeWithoutDecay() public {
        usdc.mint(ALICE, 100e6);
        vm.startPrank(ALICE);
        usdc.approve(address(hook), type(uint256).max);
        vm.expectRevert(ArcadeHook.InvalidDecaySeconds.selector);
        hook.createLaunch("Demo", "DEMO", "ipfs://demo", 0, address(0), 0, 500, 0);
        vm.stopPrank();
    }

    function test_createLaunch_revertsWhenPaused() public {
        usdc.mint(ALICE, 100e6);
        vm.prank(OWNER);
        hook.pause();

        vm.startPrank(ALICE);
        usdc.approve(address(hook), type(uint256).max);
        vm.expectRevert(); // Pausable.EnforcedPause
        hook.createLaunch("Demo", "DEMO", "ipfs://demo", 0, address(0), 0, 0, 0);
        vm.stopPrank();
    }

    function test_createLaunch_storesSnipeConfig() public {
        usdc.mint(ALICE, 100e6);
        vm.startPrank(ALICE);
        usdc.approve(address(hook), type(uint256).max);
        (address tokenAddr,) = hook.createLaunch(
            "Demo", "DEMO", "ipfs://demo", 0, address(0), 0, 1_000, 600
        );
        vm.stopPrank();

        // The config is stored...
        (uint16 startBps, uint32 decaySeconds, uint64 launchedAt) = hook.snipeConfigs(tokenAddr);
        assertEq(startBps, 1_000, "startBps stored");
        assertEq(decaySeconds, 600, "decaySeconds stored");
        // ...but the decay clock is NOT started at createLaunch. The anti-sniper
        // tax only applies in afterSwap on a GRADUATED pool, so anchoring the
        // decay at launch let the window elapse during the (hours/days) curve
        // phase -> tax always 0 by graduation (the round-4 "snipers free" HIGH).
        // launchedAt stays 0 and currentSnipeBps reads 0 through the whole curve.
        assertEq(launchedAt, 0, "clock not started until graduation");
        assertEq(hook.currentSnipeBps(tokenAddr), 0, "no snipe tax during curve");
    }

    // -------------------------------------------------------------------
    // currentSnipeBps decay
    // -------------------------------------------------------------------

    function test_snipeBps_zeroThroughoutCurvePhase() public {
        usdc.mint(ALICE, 100e6);
        vm.startPrank(ALICE);
        usdc.approve(address(hook), type(uint256).max);
        (address tokenAddr,) = hook.createLaunch(
            "Demo", "DEMO", "ipfs://demo", 0, address(0), 0, 2_000, 1_000
        );
        vm.stopPrank();

        // The anti-sniper is DORMANT for the entire curve phase: warping time
        // does NOT start the decay, because the clock anchors at graduation
        // (not launch). This is the fix for the round-4 HIGH, where a
        // launch-anchored clock had already decayed to 0 by the time the AMM
        // pool existed. The decay MATH once anchored (full value at graduation,
        // linear to 0) is exercised end-to-end in
        // ArcadeHookSwap.t.sol:test_antisniper_taxesPostGradBuy_afterLongCurve,
        // which needs a real graduated pool.
        assertEq(hook.currentSnipeBps(tokenAddr), 0, "t=0 curve, dormant");
        vm.warp(block.timestamp + 500);
        assertEq(hook.currentSnipeBps(tokenAddr), 0, "mid curve");
        vm.warp(block.timestamp + 100_000);
        assertEq(hook.currentSnipeBps(tokenAddr), 0, "long curve, still dormant");
    }

    function test_snipeBps_returnsZeroForUnknownToken() public view {
        assertEq(hook.currentSnipeBps(address(0xdead)), 0, "unknown token = zero");
    }

    // -------------------------------------------------------------------
    // Owner controls
    // -------------------------------------------------------------------

    function test_pause_onlyOwner() public {
        vm.expectRevert();
        hook.pause();

        vm.prank(OWNER);
        hook.pause();
        assertTrue(hook.paused());
    }

    function test_setTreasury_updates() public {
        vm.prank(OWNER);
        hook.setTreasury(address(0xBEEF2));
        assertEq(hook.TREASURY(), address(0xBEEF2));
    }

    function test_setTreasury_rejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(ArcadeHook.ZeroAddress.selector);
        hook.setTreasury(address(0));
    }

    function test_setTwitterEscrow_acceptsZero() public {
        // Zero is a valid sentinel (disables the escrow path).
        vm.prank(OWNER);
        hook.setTwitterEscrow(address(0));
        assertEq(hook.twitterEscrow(), address(0));
    }

    // -------------------------------------------------------------------
    // Hook callback access control + revert paths
    // -------------------------------------------------------------------

    function test_beforeSwap_revertsForNonPoolManager() public {
        PoolKey memory key = _emptyKey();
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0});
        vm.expectRevert(ArcadeHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, p, "");
    }

    function test_afterSwap_revertsForNonPoolManager() public {
        PoolKey memory key = _emptyKey();
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0});
        vm.expectRevert(ArcadeHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, p, BalanceDelta.wrap(0), "");
    }

    function test_unusedSlots_revertHookNotImplemented() public {
        PoolKey memory key = _emptyKey();
        ModifyLiquidityParams memory mlp = ModifyLiquidityParams({tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: 0});

        vm.expectRevert(ArcadeHook.HookNotImplemented.selector);
        hook.afterRemoveLiquidity(address(0), key, mlp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");

        vm.expectRevert(ArcadeHook.HookNotImplemented.selector);
        hook.beforeDonate(address(0), key, 0, 0, "");

        vm.expectRevert(ArcadeHook.HookNotImplemented.selector);
        hook.afterDonate(address(0), key, 0, 0, "");
    }

    // -------------------------------------------------------------------
    // beforeInitialize access control (Round 3)
    // -------------------------------------------------------------------

    function test_beforeInitialize_revertsOnNonHookSender() public {
        PoolKey memory key = _emptyKey();
        vm.prank(poolManagerAddr);
        vm.expectRevert(ArcadeHook.OnlyLaunchpad.selector);
        // sender argument != address(this) so the check rejects.
        hook.beforeInitialize(address(0xDEAD), key, 0);
    }

    function test_beforeInitialize_revertsOnNonUsdcPair() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0x1)),
            currency1: Currency.wrap(address(0x2)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
        vm.prank(poolManagerAddr);
        vm.expectRevert(ArcadeHook.NotUsdcPair.selector);
        hook.beforeInitialize(address(hook), key, 0);
    }

    function test_beforeInitialize_revertsOnUnregisteredToken() public {
        // Pair with USDC but the other side is not in registeredLaunches.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(usdc) < address(0x1) ? address(usdc) : address(0x1)),
            currency1: Currency.wrap(address(usdc) < address(0x1) ? address(0x1) : address(usdc)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
        vm.prank(poolManagerAddr);
        vm.expectRevert(ArcadeHook.LaunchNotRegistered.selector);
        hook.beforeInitialize(address(hook), key, 0);
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    function _emptyKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(usdc)),
            currency1: Currency.wrap(address(0x1)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
    }
}
