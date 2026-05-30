// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {
    IHooks,
    IPoolManager,
    ILaunchpadSnipe,
    Currency,
    PoolKey,
    SwapParams,
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary
} from "../v4src/interfaces/IUniswapV4Types.sol";

/// @notice Captures `take` calls so the test can assert the hook moved the
///         right amount to the right recipient.
contract MockPoolManager is IPoolManager {
    event Take(address currency, address to, uint256 amount);

    Currency public lastCurrency;
    address public lastTo;
    uint256 public lastAmount;

    function take(Currency currency, address to, uint256 amount) external override {
        lastCurrency = currency;
        lastTo = to;
        lastAmount = amount;
        emit Take(Currency.unwrap(currency), to, amount);
    }
}

/// @notice Stubs the launchpad's `currentSnipeBps` + `treasury` views.
contract MockLaunchpad is ILaunchpadSnipe {
    mapping(address => uint256) public bps;
    address public treasury_;

    function setSnipe(address token, uint256 b) external {
        bps[token] = b;
    }

    function setTreasury(address t) external {
        treasury_ = t;
    }

    function currentSnipeBps(address token) external view override returns (uint256) {
        return bps[token];
    }

    function treasury() external view override returns (address) {
        return treasury_;
    }
}

contract ArcadeAntiSniperHookTest is Test {
    MockPoolManager pm;
    MockLaunchpad lp;
    ArcadeAntiSniperHook hook;

    address constant USDC_ADDR = address(0xC1); // arbitrary
    address constant TOKEN = address(0x7E57);
    address constant TREASURY = address(0xBEEF);

    function setUp() public {
        pm = new MockPoolManager();
        lp = new MockLaunchpad();
        lp.setTreasury(TREASURY);
        hook = new ArcadeAntiSniperHook(
            IPoolManager(address(pm)),
            ILaunchpadSnipe(address(lp)),
            Currency.wrap(USDC_ADDR)
        );
    }

    // --- Permission tests -----------------------------------------------

    function test_onlyPoolManager_canCallBeforeSwap() public {
        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 100, sqrtPriceLimitX96: 0});

        // Caller is this test contract, not the pool manager → revert.
        vm.expectRevert(ArcadeAntiSniperHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, p, "");
    }

    function test_permissionFlag_isOnlyBeforeSwap() public {
        // The hook declares only the BEFORE_SWAP_FLAG (bit 7).
        assertEq(hook.getHookPermissions(), 1 << 7);
    }

    // --- Hook math -------------------------------------------------------

    function test_buyUsdcCurrency0_taxedAtConfiguredBps() public {
        lp.setSnipe(TOKEN, 500); // 5%

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        // zeroForOne=true ⇒ USDC (currency0) → TOKEN (currency1) ⇒ BUY.
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (bytes4 sel, BeforeSwapDelta delta, ) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(sel, IHooks.beforeSwap.selector, "wrong selector");
        assertEq(pm.lastAmount(), 500, "should skim 5% = 500");
        assertEq(pm.lastTo(), TREASURY, "treasury receives skim");
        assertEq(BeforeSwapDeltaLibrary.specifiedDelta(delta), int128(int256(500)));
    }

    function test_buyUsdcCurrency1_alsoTaxed() public {
        // Verify the reverse currency ordering: USDC as currency1, launch
        // token as currency0. A BUY in that pool is zeroForOne=false
        // (TOKEN -> USDC direction is a SELL, so the opposite is a BUY).
        //
        // We build the PoolKey directly here instead of going through `_key`
        // so the sort isn't applied - this lets us exercise the
        // !usdcIsCurrency0 branch even when USDC_ADDR < TOKEN.
        lp.setSnipe(TOKEN, 1_000); // 10%

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(TOKEN),
            currency1: Currency.wrap(USDC_ADDR),
            fee: 3_000,
            tickSpacing: 60,
            hooks: address(0)
        });
        SwapParams memory p = SwapParams({zeroForOne: false, amountSpecified: 5_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        hook.beforeSwap(address(0xA), key, p, "");

        assertEq(pm.lastAmount(), 500, "10% of 5000 = 500");
        assertEq(pm.lastTo(), TREASURY);
    }

    function test_sell_isNotTaxed() public {
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        // zeroForOne=false ⇒ TOKEN → USDC ⇒ SELL.
        SwapParams memory p = SwapParams({zeroForOne: false, amountSpecified: 10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta, ) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.specifiedDelta(delta), 0, "no delta on sell");
        assertEq(pm.lastAmount(), 0, "no skim recorded");
    }

    function test_noSnipeConfig_isNoOp() public {
        // lp.setSnipe never called for TOKEN → currentSnipeBps returns 0.
        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta, ) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.specifiedDelta(delta), 0);
        assertEq(pm.lastAmount(), 0);
    }

    function test_decayedToZero_isNoOp() public {
        // Snipe started but decay window has elapsed. The launchpad's
        // currentSnipeBps already returns 0 once elapsed >= decaySeconds,
        // so the mock just returns 0 here and the hook does nothing.
        lp.setSnipe(TOKEN, 0);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta, ) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.specifiedDelta(delta), 0);
    }

    function test_exactOutput_isSkippedForNow() public {
        // exact-output swaps use a negative amountSpecified. The current
        // implementation skips them and emits a no-op. Documented in the
        // hook NatSpec for the V4 memo.
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -1_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta, ) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.specifiedDelta(delta), 0);
        assertEq(pm.lastAmount(), 0);
    }

    function test_nonUsdcPool_isNoOp() public {
        // A pool with no USDC at all (eg TOKEN_A / TOKEN_B). The hook
        // shouldn't tax anything - it has no notion of "buy" without USDC.
        lp.setSnipe(TOKEN, 500);

        address tokenA = address(0xA);
        address tokenB = address(0xB);
        PoolKey memory key = _key(tokenA, tokenB);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta, ) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.specifiedDelta(delta), 0);
    }

    // --- Helpers ---------------------------------------------------------

    /// @dev Returns a PoolKey with currencies sorted in canonical order
    ///      (lower address first) - matches what V4's PoolManager expects.
    function _key(address a, address b) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 3_000,
            tickSpacing: 60,
            hooks: address(0)
        });
    }
}
