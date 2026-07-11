// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";

/// @title ArcadeV3PoolInitializer
/// @notice Clamped pool creator. Same shape as the NPM's
///         createAndInitializePoolIfNecessary, but REJECTS a seed price pinned
///         near the min/max tick.
///
///         Why: at the extreme tick the position liquidity term rounds to 0, so
///         the pool can never accept liquidity, and V3 `initialize` is one-shot
///         (a pool can never be re-priced) — so a floor/ceiling seed PERMANENTLY
///         bricks that (token0, token1, fee) combo. Canonical Uniswap V3 has no
///         such guard on-chain (the only bound is MIN/MAX_SQRT_RATIO); every V3
///         protocol relies on the FRONTEND to seed a sane price. This wrapper is
///         defense-in-depth: route the app's pool creation through it so our own
///         path can never brick a pool, even with a decimal-mismatched ratio.
///
///         Scope: this guards OUR path. A griefer calling the factory + pool
///         `initialize` DIRECTLY can still brick a fresh (pair, fee) — fully
///         closing that would require editing the core pool's `initialize`,
///         which we deliberately DON'T do to keep the fork byte-faithful for
///         Gamma / Arrakis / Revert / lending tooling.
contract ArcadeV3PoolInitializer {
    IUniswapV3Factory public immutable factory;

    /// @dev Reject seeds outside ±SAFE_TICK. MAX_TICK is 887272; 800000 leaves a
    ///      wide, decimals-tolerant band while excluding the unmintable floor.
    int24 public constant SAFE_TICK = 800000;

    event PoolInitializedClamped(
        address indexed pool,
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96,
        int24 tick
    );

    constructor(address _factory) {
        require(_factory != address(0), "zero factory");
        factory = IUniswapV3Factory(_factory);
    }

    /// @notice Create (if missing) and initialize (if not yet initialized) the
    ///         pool at a CLAMPED seed price. No-op init when already initialized.
    /// @return pool the pool address.
    function createAndInitializePoolIfNecessary(
        address tokenA,
        address tokenB,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external returns (address pool) {
        require(tokenA != tokenB, "identical tokens");
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
        require(token0 != address(0), "zero token");

        // getTickAtSqrtRatio reverts ('R') if sqrtPriceX96 is outside the hard
        // MIN/MAX_SQRT_RATIO bound; we additionally clamp to the sane band.
        int24 tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        require(tick > -SAFE_TICK && tick < SAFE_TICK, "seed price too extreme");

        pool = factory.getPool(token0, token1, fee);
        if (pool == address(0)) {
            pool = factory.createPool(token0, token1, fee);
            IUniswapV3Pool(pool).initialize(sqrtPriceX96);
            emit PoolInitializedClamped(pool, token0, token1, fee, sqrtPriceX96, tick);
        } else {
            (uint160 sqrtExisting, int24 existingTick, , , , , ) = IUniswapV3Pool(pool).slot0();
            if (sqrtExisting == 0) {
                IUniswapV3Pool(pool).initialize(sqrtPriceX96);
                emit PoolInitializedClamped(pool, token0, token1, fee, sqrtPriceX96, tick);
            } else {
                // Already initialized — possibly by a griefer who called the
                // factory + pool.initialize directly (see the scope note above).
                // Guarantee a successful return always means a MINTABLE pool: if
                // the existing price is pinned near the extreme (unmintable /
                // bricked), revert so the caller falls back to a different fee
                // tier instead of sending a doomed mint. (Audit 2026-07 F-1.)
                require(
                    existingTick > -SAFE_TICK && existingTick < SAFE_TICK,
                    "existing pool price extreme"
                );
            }
        }
    }
}
