// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/**
 * @title Minimal Uniswap-V3 + Arcade locker interfaces (0.8 side)
 * @notice Our 0.8.24 contracts (launchpad) talk to the V3 core fork and to the
 *         0.7.6 ArcadeV3Locker purely at the ABI level through these
 *         interfaces. The implementations are compiled separately:
 *           - V3 core (Factory, Pool): solc 0.7.6, deployed from artifacts
 *           - ArcadeV3Locker (v3src/): solc 0.7.6
 *         We use core pools only — no NonfungiblePositionManager / NFT.
 */

/// @notice Subset of IUniswapV3Factory.
interface IArcadeV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

/// @notice Subset of IUniswapV3Pool needed to seed and read a pool.
interface IArcadeV3Pool {
    function initialize(uint160 sqrtPriceX96) external;

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

/// @notice ArcadeV3Locker — permanently holds full-range V3 positions for
/// migrated launchpad tokens, splitting collected fees creator/platform.
interface IArcadeV3Locker {
    struct LockParams {
        address pool;
        address token0;
        address token1;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Max;
        uint256 amount1Max;
        address creator;
        address platform;
        uint16 creatorBps;
    }

    struct SingleSidedParams {
        address pool;
        address token;
        uint160 sqrtPriceX96;
        uint256 tokenAmount;
        address creator;
        address platform;
        uint16 creatorBps;
    }

    function lockFullRange(LockParams calldata p)
        external
        returns (uint256 positionId, uint128 liquidity);

    function lockSingleSided(SingleSidedParams calldata p)
        external
        returns (uint256 positionId, uint128 liquidity);

    function collectFees(uint256 positionId) external returns (uint256 amount0, uint256 amount1);

    function transferCreator(uint256 positionId, address newCreator) external;

    function positionIdByToken(address token) external view returns (uint256);
}
