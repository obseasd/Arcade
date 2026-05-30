// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {ILaunchpadSnipe} from "../v4src/interfaces/IArcadeV4Launchpad.sol";

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

/// @notice Duck-typed PoolManager mock. Only implements what our hook +
///         launchpad call. Full upstream IPoolManager has 14+ methods plus 4
///         base interfaces - too many to stub for unit tests. Tests cast
///         `IPoolManager(address(pm))` so Solidity doesn't ABI-check.
contract MockPoolManager {
    event Take(address currency, address to, uint256 amount);

    Currency public lastCurrency;
    address public lastTo;
    uint256 public lastAmount;

    function take(Currency currency, address to, uint256 amount) external {
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

    address constant USDC_ADDR = address(0xC1);
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
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -100, sqrtPriceLimitX96: 0});

        vm.expectRevert(ArcadeAntiSniperHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, p, "");
    }

    function test_permissionFlags_areBeforeAndAfterSwap() public view {
        uint160 expected = Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
        assertEq(hook.getHookPermissions(), expected);
    }

    // --- beforeSwap (exact-INPUT) ---------------------------------------

    function test_buyUsdcCurrency0_taxedAtConfiguredBps() public {
        lp.setSnipe(TOKEN, 500); // 5%

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        // Upstream: NEGATIVE amountSpecified = exact-INPUT.
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (bytes4 sel, BeforeSwapDelta delta,) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(sel, IHooks.beforeSwap.selector, "wrong selector");
        assertEq(pm.lastAmount(), 500, "should skim 5% = 500");
        assertEq(pm.lastTo(), TREASURY, "treasury receives skim");
        assertEq(BeforeSwapDeltaLibrary.getSpecifiedDelta(delta), int128(int256(500)));
    }

    function test_buyUsdcCurrency1_alsoTaxed() public {
        lp.setSnipe(TOKEN, 1_000); // 10%

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(TOKEN),
            currency1: Currency.wrap(USDC_ADDR),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        SwapParams memory p = SwapParams({zeroForOne: false, amountSpecified: -5_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        hook.beforeSwap(address(0xA), key, p, "");

        assertEq(pm.lastAmount(), 500, "10% of 5000 = 500");
        assertEq(pm.lastTo(), TREASURY);
    }

    function test_sell_isNotTaxed() public {
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        // SELL = TOKEN -> USDC. With USDC as currency0, that's zeroForOne=false.
        SwapParams memory p = SwapParams({zeroForOne: false, amountSpecified: -10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.getSpecifiedDelta(delta), 0, "no delta on sell");
        assertEq(pm.lastAmount(), 0, "no skim recorded");
    }

    function test_noSnipeConfig_isNoOp() public {
        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.getSpecifiedDelta(delta), 0);
        assertEq(pm.lastAmount(), 0);
    }

    function test_decayedToZero_isNoOp() public {
        lp.setSnipe(TOKEN, 0);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.getSpecifiedDelta(delta), 0);
    }

    function test_beforeSwap_skipsExactOutput_handledLaterInAfterSwap() public {
        // Upstream: POSITIVE amountSpecified = exact-OUTPUT.
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 1_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.getSpecifiedDelta(delta), 0, "beforeSwap should not act on exact-out");
        assertEq(pm.lastAmount(), 0, "no take call from beforeSwap");
    }

    // --- afterSwap (exact-OUTPUT) ---------------------------------------

    function test_afterSwap_taxesExactOutputBuy() public {
        // Exact-OUTPUT BUY of TOKEN. User specifies tokenOut; pool quotes the
        // USDC input. Sort: 0xC1 < 0x7E57, so currency0=USDC, currency1=TOKEN.
        // BUY = USDC -> TOKEN = currency0 -> currency1 = zeroForOne=true.
        // BalanceDelta from user perspective:
        //   amount0 (USDC) = -10_000 (they pay)
        //   amount1 (TOKEN) = +50 (they receive)
        lp.setSnipe(TOKEN, 500); // 5%

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 50, sqrtPriceLimitX96: 0});
        BalanceDelta delta = toBalanceDelta(int128(-10_000), int128(50));

        vm.prank(address(pm));
        (bytes4 sel, int128 hookDelta) = hook.afterSwap(address(0xA), key, p, delta, "");

        assertEq(sel, IHooks.afterSwap.selector);
        assertEq(pm.lastAmount(), 500, "5% of 10_000 = 500");
        assertEq(pm.lastTo(), TREASURY);
        assertEq(hookDelta, int128(500));
    }

    function test_afterSwap_ignoresExactInput() public {
        // Negative amountSpecified = exact-INPUT - already taxed in beforeSwap.
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -1_000, sqrtPriceLimitX96: 0});
        // currency0=USDC, currency1=TOKEN: amount0=-1000 (paid), amount1=+50 (received).
        BalanceDelta delta = toBalanceDelta(int128(-1_000), int128(50));

        vm.prank(address(pm));
        (, int128 hookDelta) = hook.afterSwap(address(0xA), key, p, delta, "");

        assertEq(hookDelta, int128(0), "no extra take on exact-input");
        assertEq(pm.lastAmount(), 0);
    }

    function test_afterSwap_ignoresSell() public {
        // SELL = TOKEN -> USDC = currency1 -> currency0 = zeroForOne=false.
        // From user perspective: amount0 (USDC) > 0 (received), amount1
        // (TOKEN) < 0 (paid). USDC delta POSITIVE => hook skips.
        lp.setSnipe(TOKEN, 500);

        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: false, amountSpecified: 100, sqrtPriceLimitX96: 0});
        BalanceDelta delta = toBalanceDelta(int128(50), int128(-1_000));

        vm.prank(address(pm));
        (, int128 hookDelta) = hook.afterSwap(address(0xA), key, p, delta, "");

        assertEq(hookDelta, int128(0));
        assertEq(pm.lastAmount(), 0);
    }

    function test_afterSwap_onlyPoolManager() public {
        PoolKey memory key = _key(USDC_ADDR, TOKEN);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 100, sqrtPriceLimitX96: 0});
        BalanceDelta delta = toBalanceDelta(int128(0), int128(1_000));

        vm.expectRevert(ArcadeAntiSniperHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, p, delta, "");
    }

    function test_nonUsdcPool_isNoOp() public {
        lp.setSnipe(TOKEN, 500);

        address tokenA = address(0xA);
        address tokenB = address(0xB);
        PoolKey memory key = _key(tokenA, tokenB);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -10_000, sqrtPriceLimitX96: 0});

        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0xA), key, p, "");

        assertEq(BeforeSwapDeltaLibrary.getSpecifiedDelta(delta), 0);
    }

    // --- Helpers ---------------------------------------------------------

    function _key(address a, address b) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }
}
