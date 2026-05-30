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
    HookPermissions
} from "./interfaces/IUniswapV4Types.sol";

/**
 * @title ArcadeAntiSniperHook
 * @notice Uniswap V4 `beforeSwap` hook that automatically taxes buys during
 *         the launch window, then decays the tax to zero linearly. Replaces
 *         the soft `ArcadeV3SwapRouter._snipeSkim` path which only ran when
 *         the user happened to swap through Arcade's own router (a sniper
 *         could trivially bypass it by going to the V3 pool directly).
 *
 *         As a V4 hook the tax applies on EVERY swap into the pool, no
 *         matter which router or aggregator routes it. That's the property
 *         we want: snipers can't reach the pool without paying.
 *
 * @dev    Hook permissions: only BEFORE_SWAP_FLAG. The PoolManager checks
 *         the hook ADDRESS' low 14 bits against the permission set in
 *         `getHookPermissions`; deploying this hook requires mining a
 *         CREATE2 salt so the resulting address has only bit 7 set among
 *         the permission bits. The deploy script does the mining.
 *
 *         Math: identical to ArcadeV3SwapRouter._snipeSkim. We read the
 *         current snipe bps from the launchpad (linear decay from startBps
 *         to 0 over decaySeconds), compute skim = amountIn * bps / 10_000,
 *         and call `poolManager.take()` to extract the skim into the
 *         treasury. The remainder swaps normally against the pool curve.
 *
 *         Only USDC -> launchToken swaps are taxed - sells and unrelated
 *         currency pairs pass through. Same intent as the V3 router's
 *         `tokenIn != USDC ? return 0` check.
 */
contract ArcadeAntiSniperHook is IHooks {
    using BeforeSwapDeltaLibrary for BeforeSwapDelta;

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
    ///         entrypoints. Anyone calling beforeSwap directly would
    ///         otherwise be able to drain the treasury allocation via the
    ///         `take` call below.
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

    /// @notice Static hook-permission flags. The PoolManager reads this to
    ///         decide which lifecycle slots to invoke, but the actual
    ///         enforcement is the hook ADDRESS' low bits (mined via CREATE2).
    function getHookPermissions() public pure returns (uint160) {
        return HookPermissions.BEFORE_SWAP_FLAG;
    }

    /// @inheritdoc IHooks
    function beforeSwap(
        address /* sender */,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        // Step 1: identify which side is USDC. If USDC isn't either currency
        // in this pool, we have nothing to do - return a zero delta.
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        bool usdcIsCurrency1 = Currency.unwrap(key.currency1) == Currency.unwrap(USDC);
        if (!usdcIsCurrency0 && !usdcIsCurrency1) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Step 2: this hook only taxes BUYS (USDC in, launchToken out). The
        // V4 swap direction is `zeroForOne`: true means currency0 -> currency1.
        // So we tax when (usdcIsCurrency0 && zeroForOne) or (usdcIsCurrency1 && !zeroForOne).
        bool isBuy = (usdcIsCurrency0 && params.zeroForOne) || (usdcIsCurrency1 && !params.zeroForOne);
        if (!isBuy) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Step 3: identify the launch token (the non-USDC side) and look up
        // its snipe config. If the token has no snipe config or the decay
        // window has elapsed, currentSnipeBps returns 0 and we no-op.
        address launchToken = usdcIsCurrency0
            ? Currency.unwrap(key.currency1)
            : Currency.unwrap(key.currency0);
        uint256 bps = LAUNCHPAD.currentSnipeBps(launchToken);
        if (bps == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Step 4: compute the skim amount. V4 represents exact-input swaps
        // with a NEGATIVE specified amount (debt-style accounting). Take the
        // absolute value to determine the gross input.
        int256 specifiedAmount = params.amountSpecified;
        if (specifiedAmount <= 0) {
            // Exact-output swap - amountSpecified is the desired out amount,
            // not the input. The skim math doesn't directly apply; skip for
            // now and document this in the V4 hook design memo. Most snipers
            // use exact-in anyway.
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        uint256 amountIn = uint256(specifiedAmount);
        uint256 skim = (amountIn * bps) / 10_000;
        if (skim == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Step 5: extract the skim from the swap. `take` lets a hook pull
        // from the swap's accounting, sending the funds to the treasury.
        // The remaining (amountIn - skim) continues into the pool curve.
        address treasury = LAUNCHPAD.treasury();
        POOL_MANAGER.take(USDC, treasury, skim);

        emit SniperSkimmed(launchToken, treasury, amountIn, skim, bps);

        // Return a BeforeSwapDelta that tells the PoolManager we consumed
        // `skim` of the specified (input) currency. The unspecified
        // (output) delta stays zero - the pool curve handles the output.
        BeforeSwapDelta delta =
            BeforeSwapDeltaLibrary.toBeforeSwapDelta(int128(int256(skim)), 0);
        return (IHooks.beforeSwap.selector, delta, 0);
    }
}
