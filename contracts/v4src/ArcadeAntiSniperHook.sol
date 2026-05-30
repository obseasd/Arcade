// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    IHooks,
    IPoolManager,
    ILaunchpadSnipe,
    Currency,
    PoolKey,
    SwapParams,
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    BalanceDelta,
    BalanceDeltaLibrary,
    HookPermissions
} from "./interfaces/IUniswapV4Types.sol";

/**
 * @title ArcadeAntiSniperHook
 * @notice Uniswap V4 hook that automatically taxes buys during the launch
 *         window, then decays the tax to zero linearly. Replaces the soft
 *         `ArcadeV3SwapRouter._snipeSkim` path which only ran when the user
 *         happened to swap through Arcade's own router (a sniper could
 *         trivially bypass it by going to the V3 pool directly).
 *
 *         As a V4 hook the tax applies on EVERY swap into the pool, no
 *         matter which router or aggregator routes it. That's the property
 *         we want: snipers can't reach the pool without paying.
 *
 * @dev    Hook permissions: BEFORE_SWAP_FLAG + AFTER_SWAP_FLAG. We need
 *         both because the swap shape matters:
 *
 *         - exact-input buys (user specifies USDC amount): handled in
 *           beforeSwap. We see the input amount, compute the skim, call
 *           `pm.take()` to redirect it to treasury, and return a
 *           BeforeSwapDelta that tells the pool to process the reduced
 *           amount.
 *
 *         - exact-output buys (user specifies tokens out): we don't know
 *           the USDC input at beforeSwap time. afterSwap runs once the pool
 *           has settled the swap; we read the actual USDC delta from
 *           BalanceDelta, compute the skim, take it to treasury, and return
 *           an int128 hookDelta so the pool charges the user extra.
 *
 *         The PoolManager checks the hook ADDRESS' low 14 bits against the
 *         permission set; deploying this hook requires mining a CREATE2
 *         salt so the resulting address has bit 7 (BEFORE_SWAP_FLAG) AND
 *         bit 6 (AFTER_SWAP_FLAG) set among the permission bits.
 *         `v4script/MineHookSalt.s.sol` does that mining.
 */
contract ArcadeAntiSniperHook is IHooks {
    using BeforeSwapDeltaLibrary for BeforeSwapDelta;
    using BalanceDeltaLibrary for BalanceDelta;

    /// @notice The pool manager calling our hook. Set at construction.
    IPoolManager public immutable POOL_MANAGER;
    /// @notice Arcade launchpad - read for the per-token snipe config and
    ///         treasury address. The contract we already deploy.
    ILaunchpadSnipe public immutable LAUNCHPAD;
    /// @notice USDC on Arc. Tax only applies when USDC is the input side.
    Currency public immutable USDC;

    error NotPoolManager();
    error InvalidLaunchpad();

    event SniperSkimmed(
        address indexed token,
        address indexed treasury,
        uint256 amountIn,
        uint256 skimAmount,
        uint256 bpsApplied
    );

    /// @notice The PoolManager is the only authorised caller for hook
    ///         entrypoints. Anyone calling beforeSwap/afterSwap directly
    ///         would otherwise be able to drain the treasury allocation via
    ///         the `take` calls below.
    modifier onlyPoolManager() {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_, ILaunchpadSnipe launchpad_, Currency usdc_) {
        if (address(launchpad_) == address(0)) revert InvalidLaunchpad();
        POOL_MANAGER = poolManager_;
        LAUNCHPAD = launchpad_;
        USDC = usdc_;
    }

    /// @notice Hook permission flags. Both BEFORE_SWAP and AFTER_SWAP are
    ///         required so the address can encode them. The salt-mining
    ///         script targets exactly this combination.
    function getHookPermissions() public pure returns (uint160) {
        return HookPermissions.BEFORE_SWAP_FLAG | HookPermissions.AFTER_SWAP_FLAG;
    }

    // -------------------------------------------------------------------
    // beforeSwap: exact-input buys
    // -------------------------------------------------------------------

    /// @inheritdoc IHooks
    function beforeSwap(
        address /* sender */,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        // Only act on BUYs (USDC into the pool) - sells, non-USDC pools, and
        // tokens with no snipe config all pass through transparently.
        (bool isBuy, address launchToken) = _classify(key, params.zeroForOne);
        if (!isBuy) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        uint256 bps = LAUNCHPAD.currentSnipeBps(launchToken);
        if (bps == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        // Exact-input only. Exact-output is handled in afterSwap because we
        // need to see the realised USDC delta first.
        int256 specifiedAmount = params.amountSpecified;
        if (specifiedAmount <= 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 amountIn = uint256(specifiedAmount);
        uint256 skim = (amountIn * bps) / 10_000;
        if (skim == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        address treasury = LAUNCHPAD.treasury();
        POOL_MANAGER.take(USDC, treasury, skim);

        emit SniperSkimmed(launchToken, treasury, amountIn, skim, bps);

        BeforeSwapDelta delta =
            BeforeSwapDeltaLibrary.toBeforeSwapDelta(int128(int256(skim)), 0);
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    // -------------------------------------------------------------------
    // afterSwap: exact-output buys
    // -------------------------------------------------------------------

    /// @inheritdoc IHooks
    function afterSwap(
        address /* sender */,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, int128) {
        // Only relevant for exact-output BUYS (positive amountSpecified means
        // the user specified the output side). Exact-input was already taxed
        // in beforeSwap.
        if (params.amountSpecified <= 0) {
            return (IHooks.afterSwap.selector, int128(0));
        }
        (bool isBuy, address launchToken) = _classify(key, params.zeroForOne);
        if (!isBuy) return (IHooks.afterSwap.selector, int128(0));

        uint256 bps = LAUNCHPAD.currentSnipeBps(launchToken);
        if (bps == 0) return (IHooks.afterSwap.selector, int128(0));

        // Recover the actual USDC paid by the user from BalanceDelta.
        // delta.amountX is signed from the POOL's perspective: positive =
        // received by the pool, negative = sent out by the pool. The USDC
        // side is what the user paid IN, so it's positive on the USDC slot.
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        int128 usdcDelta = usdcIsCurrency0 ? delta.amount0() : delta.amount1();
        if (usdcDelta <= 0) {
            // Shouldn't happen for a BUY, but guard before casting.
            return (IHooks.afterSwap.selector, int128(0));
        }
        uint256 amountIn = uint256(uint128(usdcDelta));
        uint256 skim = (amountIn * bps) / 10_000;
        if (skim == 0) return (IHooks.afterSwap.selector, int128(0));

        address treasury = LAUNCHPAD.treasury();
        POOL_MANAGER.take(USDC, treasury, skim);

        emit SniperSkimmed(launchToken, treasury, amountIn, skim, bps);

        // The returned int128 is added to the UNSPECIFIED currency delta,
        // which for an exact-output swap is USDC. A positive return makes
        // the pool charge that much more from the user, covering the skim.
        return (IHooks.afterSwap.selector, int128(int256(skim)));
    }

    // -------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------

    /// @dev Determines whether this swap is a USDC -> launch token buy and
    ///      returns the launch token address if so. Used by both hook
    ///      entry-points to avoid duplicating the currency classification.
    function _classify(PoolKey calldata key, bool zeroForOne)
        internal
        view
        returns (bool isBuy, address launchToken)
    {
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        bool usdcIsCurrency1 = Currency.unwrap(key.currency1) == Currency.unwrap(USDC);
        if (!usdcIsCurrency0 && !usdcIsCurrency1) return (false, address(0));

        // BUY = USDC into the pool. In zeroForOne=true, currency0 -> currency1
        // direction: the input side is currency0.
        bool buy = (usdcIsCurrency0 && zeroForOne) || (usdcIsCurrency1 && !zeroForOne);
        if (!buy) return (false, address(0));

        // Caller pattern: `(bool isBuy, address launchToken) = _classify(...)`
        // - we MUST assign isBuy explicitly here, otherwise the named return
        // defaults to false even though we passed all the buy checks.
        isBuy = true;
        launchToken = usdcIsCurrency0
            ? Currency.unwrap(key.currency1)
            : Currency.unwrap(key.currency0);
    }
}
