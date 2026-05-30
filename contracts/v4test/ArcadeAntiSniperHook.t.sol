// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {
    IHooks,
    IPoolManager,
    IUnlockCallback,
    ILaunchpadSnipe,
    Currency,
    PoolKey,
    SwapParams,
    ModifyLiquidityParams,
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    BalanceDelta,
    BalanceDeltaLibrary,
    HookPermissions
} from "../v4src/interfaces/IUniswapV4Types.sol";

/// @notice Captures `take` calls so the test can assert the hook moved the
///         right amount to the right recipient. Also no-ops the rest of the
///         IPoolManager surface our launchpad / hook touch so this contract
///         can be used in both hook-only and launchpad-integration tests.
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

    // No-op implementations so the contract is not abstract. The launchpad
    // integration tests in ArcadeV4Launchpad.t.sol use a SUBCLASS that
    // overrides these to capture their inputs.
    function initialize(PoolKey calldata, uint160) external pure override returns (int24) {
        return 0;
    }
    function unlock(bytes calldata) external pure override returns (bytes memory) {
        return "";
    }
    function modifyLiquidity(
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure override returns (BalanceDelta, BalanceDelta) {
        return (BalanceDelta.wrap(0), BalanceDelta.wrap(0));
    }
    function sync(Currency) external override {}
    function settle() external payable override returns (uint256) {
        return 0;
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

    function test_permissionFlags_areBeforeAndAfterSwap() public {
        // The hook declares BEFORE_SWAP_FLAG (bit 7) AND AFTER_SWAP_FLAG
        // (bit 6) - the address-mining script must satisfy both.
        uint160 expected = HookPermissions.BEFORE_SWAP_FLAG | HookPermissions.AFTER_SWAP_FLAG;
        assertEq(hook.getHookPermissions(), expected);
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

    function test_beforeSwap_skipsExactOutput_handledLaterInAfterSwap() public {
        // exact-output uses a negative amountSpecified. beforeSwap must not
        // attempt to tax it (we don't know the input amount yet) - afterSwap
        // picks it up once the pool has settled the swap.
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -1_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta, ) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.specifiedDelta(delta), 0, "beforeSwap should not act on exact-out");
        assertEq(pm.lastAmount(), 0, "no take call from beforeSwap");
    }

    // --- afterSwap (exact-output handling) ------------------------------

    function test_afterSwap_taxesExactOutputBuy() public {
        // Scenario: user does an exact-OUTPUT buy of TOKEN. They specify the
        // tokenOut amount; the pool quotes the USDC input. afterSwap sees
        // the realised BalanceDelta and we tax the actual USDC paid.
        //
        // Address sort: USDC_ADDR=0xC1, TOKEN=0x7E57. 0xC1 < 0x7E57, so
        // the canonical key has currency0=USDC and currency1=TOKEN.
        // A BUY moves USDC INTO the pool (positive amount0 from the pool's
        // perspective) and TOKEN OUT of the pool (negative amount1).
        lp.setSnipe(TOKEN, 500); // 5%

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 100, sqrtPriceLimitX96: 0});
        BalanceDelta delta = BalanceDeltaLibrary.pack(int128(10_000), int128(-50));

        vm.prank(address(pm));
        (bytes4 sel, int128 hookDelta) = hook.afterSwap(address(0xA), key, p, delta, "");

        assertEq(sel, IHooks.afterSwap.selector);
        assertEq(pm.lastAmount(), 500, "5% of 10_000 = 500");
        assertEq(pm.lastTo(), TREASURY);
        // hookDelta is added to the unspecified side - positive means the
        // pool charges the user extra USDC to cover the skim.
        assertEq(hookDelta, int128(500));
    }

    function test_afterSwap_ignoresExactInput() public {
        // amountSpecified <= 0 means exact-input - already taxed in
        // beforeSwap. afterSwap must not double-tax.
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -1_000, sqrtPriceLimitX96: 0});
        BalanceDelta delta = BalanceDeltaLibrary.pack(int128(1_000), int128(-50));

        vm.prank(address(pm));
        (, int128 hookDelta) = hook.afterSwap(address(0xA), key, p, delta, "");

        assertEq(hookDelta, int128(0), "no extra take on exact-input");
        assertEq(pm.lastAmount(), 0);
    }

    function test_afterSwap_ignoresSell() public {
        // Sells (TOKEN -> USDC) leave USDC delta NEGATIVE on the pool side
        // (pool lost USDC). The hook must NOT tax sells.
        //
        // Canonical sort: currency0=USDC, currency1=TOKEN. A SELL is
        // zeroForOne=false (currency1 -> currency0, ie TOKEN -> USDC).
        // BalanceDelta: pool LOST USDC (amount0 negative), GAINED TOKEN
        // (amount1 positive).
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: false, amountSpecified: 100, sqrtPriceLimitX96: 0});
        BalanceDelta delta = BalanceDeltaLibrary.pack(int128(-1_000), int128(50));

        vm.prank(address(pm));
        (, int128 hookDelta) = hook.afterSwap(address(0xA), key, p, delta, "");

        assertEq(hookDelta, int128(0));
        assertEq(pm.lastAmount(), 0);
    }

    function test_afterSwap_onlyPoolManager() public {
        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 100, sqrtPriceLimitX96: 0});
        BalanceDelta delta = BalanceDeltaLibrary.pack(int128(0), int128(1_000));

        vm.expectRevert(ArcadeAntiSniperHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, p, delta, "");
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
