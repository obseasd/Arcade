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
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

/// @notice ArcadeTokenVault — holds a locked/vesting slice of a launch's supply.
interface IArcadeTokenVault {
    function createVest(
        address token,
        address recipient,
        uint256 amount,
        uint64 lockupDuration,
        uint64 vestingDuration
    ) external returns (uint256 id);
}

/// @notice ArcadeV3SwapRouter — used by the launchpad for the optional creator
/// buy and by ArcadeMultiSwap for V3-paired tokens (Clanker V3 launches).
interface IArcadeV3Router {
    function exactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external returns (uint256 amountOut);

    function exactInputThroughUsdc(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 usdcMidMin,
        uint256 deadline
    ) external returns (uint256 amountOut);
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

/// @notice ArcadeV3Locker — permanently holds single-sided V3 launch positions
/// and routes their fees to up to 3 configurable recipients.
interface IArcadeV3Locker {
    enum RewardToken {Both, Paired, Clanker}

    struct Recipient {
        address recipient;
        address admin;
        uint16 bps;
        RewardToken tokenPref;
    }

    struct SingleSidedParams {
        address pool;
        address paired;
        address token;
        uint160 sqrtPriceX96;
        uint256 tokenAmount;
        uint16[] positionBps; // supply split per range; sums to 10000 (len 1 or 3)
        Recipient[] recipients;
        uint24 fee; // CSEC-013: pool fee tier so the locker can re-derive
        // factory.getPool(token, paired, fee) and verify it matches `pool`.
    }

    function lockSingleSided(SingleSidedParams calldata p)
        external
        returns (uint256 positionId, uint128 liquidity);

    function collectFees(uint256 positionId)
        external
        returns (uint256 pairedAmount, uint256 clankerAmount);

    function updateRecipient(uint256 positionId, uint256 index, address newRecipient) external;
    function updateAdmin(uint256 positionId, uint256 index, address newAdmin) external;

    function positionIdByToken(address token) external view returns (uint256);

    /// @notice Address of the optional Twitter escrow. May be address(0) if the
    ///         integration is disabled. Used by the launchpad to enforce the
    ///         M-13 invariant that recipient==escrow ⇒ admin==escrow.
    function twitterEscrow() external view returns (address);
    function recipientsCount(uint256 positionId) external view returns (uint256);
    function rangeCount(uint256 positionId) external view returns (uint256);
    function getRecipients(uint256 positionId) external view returns (Recipient[] memory);
}
