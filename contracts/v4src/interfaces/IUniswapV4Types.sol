// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title IUniswapV4Types
 * @notice Vendored Uniswap V4 core types we need to compile the anti-sniper
 *         hook without depending on the v4-core git submodule.
 *
 *         When Arc actually has Uniswap V4 deployed (or we deploy our own
 *         fork), this file is replaced by the upstream imports:
 *
 *           import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
 *           import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
 *           import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
 *           ...
 *
 *         Until then this gives us:
 *           - a compileable hook contract for the integration design
 *           - a place to lock in the exact ABI we'll target
 *           - tests that exercise the hook math against a mocked PoolManager
 */

/// @notice ERC20 / native ETH currency wrapper used by V4 pools.
type Currency is address;

/// @notice Identifies a V4 pool. Two currencies + fee tier + tickSpacing +
///         the hook contract address (which differentiates pools with the
///         same underlying tokens but different hooks).
struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Arguments passed to PoolManager.swap by the swap router.
struct SwapParams {
    /// @notice True if the swap is in the direction currency0 -> currency1.
    bool zeroForOne;
    /// @notice Exact-in (positive) or exact-out (negative) amount.
    int256 amountSpecified;
    /// @notice Optional sqrtPrice limit for the swap.
    uint160 sqrtPriceLimitX96;
}

/// @notice Packed (int128 specifiedDelta, int128 unspecifiedDelta) returned
///         by beforeSwap. Zero = no delta adjustment, hook is transparent.
type BeforeSwapDelta is int256;

/// @notice The V4 PoolManager subset our hook talks to. We only need the
///         interface for currency settling - the rest is provided by the
///         PoolManager when it invokes our beforeSwap.
interface IPoolManager {
    /// @notice Authorises a hook to take a fee from the swap input. The fee
    ///         is added back into the pool's reserves so subsequent LPs
    ///         capture it on the swap path.
    function take(Currency currency, address to, uint256 amount) external;
}

/// @notice Minimal IHooks interface (V4 core defines 14 hook slots; we only
///         implement beforeSwap so this captures just that one).
interface IHooks {
    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4 selector, BeforeSwapDelta delta, uint24 feeOverride);
}

/// @notice Library mirror of the V4 Hooks lib's bitmask flags. The hook
///         contract address itself encodes its permissions in its low bits;
///         the PoolManager checks the address against these flags before
///         invoking each hook slot.
library HookPermissions {
    uint160 internal constant BEFORE_INITIALIZE_FLAG = 1 << 13;
    uint160 internal constant AFTER_INITIALIZE_FLAG = 1 << 12;
    uint160 internal constant BEFORE_ADD_LIQUIDITY_FLAG = 1 << 11;
    uint160 internal constant AFTER_ADD_LIQUIDITY_FLAG = 1 << 10;
    uint160 internal constant BEFORE_REMOVE_LIQUIDITY_FLAG = 1 << 9;
    uint160 internal constant AFTER_REMOVE_LIQUIDITY_FLAG = 1 << 8;
    /// @notice The only flag we set on the anti-sniper hook.
    uint160 internal constant BEFORE_SWAP_FLAG = 1 << 7;
    uint160 internal constant AFTER_SWAP_FLAG = 1 << 6;
    uint160 internal constant BEFORE_DONATE_FLAG = 1 << 5;
    uint160 internal constant AFTER_DONATE_FLAG = 1 << 4;
    uint160 internal constant BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3;
    uint160 internal constant AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2;
    uint160 internal constant AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG = 1 << 1;
    uint160 internal constant AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG = 1 << 0;
}

/// @notice Packs / unpacks BeforeSwapDelta the same way v4-core does.
library BeforeSwapDeltaLibrary {
    /// @notice A zero delta: the hook is transparent for this swap.
    BeforeSwapDelta internal constant ZERO_DELTA = BeforeSwapDelta.wrap(0);

    function toBeforeSwapDelta(int128 specified, int128 unspecified)
        internal
        pure
        returns (BeforeSwapDelta)
    {
        // Match v4-core's encoding: specified in the upper 128 bits.
        return BeforeSwapDelta.wrap((int256(specified) << 128) | (int256(uint256(uint128(unspecified)))));
    }

    function specifiedDelta(BeforeSwapDelta delta) internal pure returns (int128) {
        return int128(BeforeSwapDelta.unwrap(delta) >> 128);
    }

    function unspecifiedDelta(BeforeSwapDelta delta) internal pure returns (int128) {
        return int128(int256(BeforeSwapDelta.unwrap(delta)));
    }
}

/// @notice Launchpad surface our hook reads. Mirrors the existing function
///         on ArcadeLaunchpad (used today by ArcadeV3SwapRouter._snipeSkim).
interface ILaunchpadSnipe {
    function currentSnipeBps(address token) external view returns (uint256);
    function treasury() external view returns (address);
}
