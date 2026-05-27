// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @notice Test-only helper to execute swaps directly against a V3 pool so
 * integration tests can generate LP fees. Must be pre-funded with the input
 * token. NOT for production use.
 */
contract TestSwapper is IUniswapV3SwapCallback {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    function swap(address pool, bool zeroForOne, int256 amountSpecified) external {
        uint160 limit = zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
        IUniswapV3Pool(pool).swap(address(this), zeroForOne, amountSpecified, limit, "");
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        if (amount0Delta > 0) IERC20Min(pool.token0()).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20Min(pool.token1()).transfer(msg.sender, uint256(amount1Delta));
    }
}
