// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/**
 * @title Minimal Uniswap-V3 interfaces used by Arcade
 * @notice We redeclare only the functions Arcade needs against our 0.8.24
 *         toolchain. The actual V3 implementation (factory, pool, position
 *         manager) is the standard Uniswap V3 deployment forked onto Arc and
 *         compiled with solc 0.7.6; these interfaces match its ABI exactly so
 *         our 0.8 contracts can call into it.
 *
 *         Forked from:
 *           - @uniswap/v3-core    (Factory, Pool)
 *           - @uniswap/v3-periphery (NonfungiblePositionManager)
 */

/// @notice Subset of IUniswapV3Factory.
interface IArcadeV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

/// @notice Subset of IUniswapV3Pool needed to read pool state.
interface IArcadeV3Pool {
    /// @return sqrtPriceX96 the current price as a sqrt(token1/token0) Q64.96 value
    /// @return tick the current tick
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function liquidity() external view returns (uint128);
}

/// @notice Subset of INonfungiblePositionManager (v3-periphery).
interface IArcadeV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function factory() external view returns (address);

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}
