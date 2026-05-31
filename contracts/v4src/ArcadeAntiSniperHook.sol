// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ILaunchpadSnipe} from "./interfaces/IArcadeV4Launchpad.sol";

// Upstream V4 core.
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

/**
 * @title ArcadeAntiSniperHook
 * @notice Uniswap V4 hook that automatically taxes buys during the launch
 *         window, then decays the tax to zero linearly. Replaces the soft
 *         `ArcadeV3SwapRouter._snipeSkim` path which only ran when the user
 *         happened to swap through Arcade's own router (a sniper could
 *         trivially bypass it by going to the V3 pool directly).
 *
 *         As a V4 hook the tax applies on EVERY swap into the pool, no matter
 *         which router or aggregator routes it. That's the property we want:
 *         snipers can't reach the pool without paying.
 *
 * @dev    Hook permissions: BEFORE_SWAP_FLAG + AFTER_SWAP_FLAG. The address
 *         encodes both, mined via CREATE2 (`v4script/MineHookSalt.s.sol`).
 *
 *         Sign convention (matches v4-core upstream):
 *           amountSpecified < 0  =>  exact-INPUT  (user said "spend X USDC")
 *           amountSpecified > 0  =>  exact-OUTPUT (user said "give me Y token")
 *
 *         - exact-INPUT buys are taxed in beforeSwap. We know the USDC amount
 *           up-front; we take the skim and return a BeforeSwapDelta that
 *           reduces the input the pool sees.
 *
 *         - exact-OUTPUT buys are taxed in afterSwap. beforeSwap can't see
 *           how much USDC will end up being charged; afterSwap can read it
 *           from BalanceDelta. We return a positive hook delta on the
 *           unspecified currency so the pool charges the user extra USDC to
 *           cover the skim.
 *
 *         The eight other IHooks slots are implemented as reverts so that
 *         even if a misconfigured PoolManager dispatched to them, nothing
 *         silently succeeds. The address bits gate which slots actually fire.
 */
contract ArcadeAntiSniperHook is IHooks {
    /// @notice The pool manager calling our hook. Set at construction.
    IPoolManager public immutable POOL_MANAGER;
    /// @notice Arcade launchpad - read for the per-token snipe config only.
    ///         Treasury is NOT read from here (see audit finding #3): the
    ///         hook trusts its own immutable TREASURY instead, so a
    ///         compromised or upgraded launchpad can't redirect skims.
    ILaunchpadSnipe public immutable LAUNCHPAD;
    /// @notice USDC on Arc. Tax only applies when USDC is the input side.
    Currency public immutable USDC;
    /// @notice Recipient of the snipe skim. Hardcoded at construction so the
    ///         hook is independent of any future launchpad upgrade.
    address public immutable TREASURY;

    error NotPoolManager();
    error InvalidLaunchpad();
    error InvalidTreasury();
    error HookNotImplemented();

    event SniperSkimmed(
        address indexed token,
        address indexed treasury,
        uint256 amountIn,
        uint256 skimAmount,
        uint256 bpsApplied
    );

    modifier onlyPoolManager() {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        ILaunchpadSnipe launchpad_,
        Currency usdc_,
        address treasury_
    ) {
        if (address(launchpad_) == address(0)) revert InvalidLaunchpad();
        if (treasury_ == address(0)) revert InvalidTreasury();
        POOL_MANAGER = poolManager_;
        LAUNCHPAD = launchpad_;
        USDC = usdc_;
        TREASURY = treasury_;
    }

    /// @notice Hook permission flags the deployed address must encode in its
    ///         low 14 bits. `MineHookSalt` / `DeployV4` target exactly this.
    ///
    /// @dev MUST include both `_RETURNS_DELTA_FLAG` bits — without them, the
    ///      pool manager dispatcher discards the BeforeSwapDelta / int128 we
    ///      return, leaving the `pm.take(...)` we just issued as an unresolved
    ///      hook delta that fails `CurrencyNotSettled` at unlock close. That
    ///      would DOS every taxed buy during the snipe window.
    function getHookPermissions() public pure returns (uint160) {
        return Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    }

    // -------------------------------------------------------------------
    // beforeSwap: exact-INPUT buys
    // -------------------------------------------------------------------

    /// @inheritdoc IHooks
    function beforeSwap(
        address, /* sender */
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        (bool isBuy, address launchToken) = _classify(key, params.zeroForOne);
        if (!isBuy) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        uint256 bps = LAUNCHPAD.currentSnipeBps(launchToken);
        if (bps == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        // Only exact-INPUT is handled here. Exact-output goes through
        // afterSwap because we need the realised USDC delta.
        int256 specifiedAmount = params.amountSpecified;
        if (specifiedAmount >= 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 amountIn = uint256(-specifiedAmount);
        uint256 skim = (amountIn * bps) / 10_000;
        if (skim == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        POOL_MANAGER.take(USDC, TREASURY, skim);

        emit SniperSkimmed(launchToken, TREASURY, amountIn, skim, bps);

        // For an exact-INPUT swap the SPECIFIED currency is USDC. A positive
        // specified-delta tells the pool the hook took that much of the
        // specified currency, so the pool sees a reduced input amount.
        BeforeSwapDelta delta = toBeforeSwapDelta(int128(int256(skim)), 0);
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    // -------------------------------------------------------------------
    // afterSwap: exact-OUTPUT buys
    // -------------------------------------------------------------------

    /// @inheritdoc IHooks
    function afterSwap(
        address, /* sender */
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, int128) {
        // Only relevant for exact-OUTPUT buys (positive amountSpecified). The
        // exact-input case was already taxed in beforeSwap.
        if (params.amountSpecified <= 0) {
            return (IHooks.afterSwap.selector, int128(0));
        }
        (bool isBuy, address launchToken) = _classify(key, params.zeroForOne);
        if (!isBuy) return (IHooks.afterSwap.selector, int128(0));

        uint256 bps = LAUNCHPAD.currentSnipeBps(launchToken);
        if (bps == 0) return (IHooks.afterSwap.selector, int128(0));

        // BalanceDelta from the user's perspective: positive = user is owed
        // currency from the pool, negative = user owes currency to the pool.
        // For a BUY the user owes USDC (negative on the USDC slot) and is
        // owed tokens (positive on the token slot). amountIn is the magnitude.
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        int128 usdcDelta = usdcIsCurrency0 ? delta.amount0() : delta.amount1();
        if (usdcDelta >= 0) return (IHooks.afterSwap.selector, int128(0));
        uint256 amountIn = uint256(uint128(-usdcDelta));

        uint256 skim = (amountIn * bps) / 10_000;
        if (skim == 0) return (IHooks.afterSwap.selector, int128(0));

        POOL_MANAGER.take(USDC, TREASURY, skim);

        emit SniperSkimmed(launchToken, TREASURY, amountIn, skim, bps);

        // The returned int128 is added to the UNSPECIFIED currency delta. For
        // an exact-output swap, the unspecified currency is the input side
        // (USDC). A positive return makes the pool charge that much more from
        // the user, covering the skim we just took.
        return (IHooks.afterSwap.selector, int128(int256(skim)));
    }

    // -------------------------------------------------------------------
    // Unused IHooks slots - revert so a misconfigured address can't silently
    // succeed. The PoolManager only dispatches the slots whose address bits
    // are set, so in normal use these are unreachable.
    // -------------------------------------------------------------------

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    // -------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------

    /// @dev Determines whether this swap is a USDC -> launch token buy and
    ///      returns the launch token address if so.
    function _classify(PoolKey calldata key, bool zeroForOne)
        internal
        view
        returns (bool isBuy, address launchToken)
    {
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        bool usdcIsCurrency1 = Currency.unwrap(key.currency1) == Currency.unwrap(USDC);
        if (!usdcIsCurrency0 && !usdcIsCurrency1) return (false, address(0));

        bool buy = (usdcIsCurrency0 && zeroForOne) || (usdcIsCurrency1 && !zeroForOne);
        if (!buy) return (false, address(0));

        isBuy = true;
        launchToken = usdcIsCurrency0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
    }
}
