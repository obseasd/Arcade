// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";

/**
 * @title ArcadeV3Quoter
 * @notice Off-chain quoting for Arcade's V3 pools using the canonical
 *         "revert trick": we trigger a real swap, but the swap callback reverts
 *         with the computed output amount encoded in the revert data, so no
 *         state changes. Callers must use `eth_call` (these functions are not
 *         `view` because the EVM can't mark callback-reverting calls as view,
 *         but they never persist state). Mirrors Uniswap's QuoterV2.
 *
 *         No OpenZeppelin / periphery dependency — deploys cleanly on Arc.
 */
contract ArcadeV3Quoter is IUniswapV3SwapCallback {
    address public immutable factory;
    address public immutable USDC;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    constructor(address factory_, address usdc_) {
        factory = factory_;
        USDC = usdc_;
    }

    /// @notice Quote a single-hop exact-input swap. Reverts internally; call via eth_call.
    function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        public
        returns (uint256 amountOut)
    {
        address pool = IUniswapV3Factory(factory).getPool(tokenIn, tokenOut, fee);
        require(pool != address(0), "NO_POOL");
        bool zeroForOne = tokenIn < tokenOut;
        try IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(zeroForOne)
        ) {} catch (bytes memory reason) {
            return _parseRevert(reason);
        }
    }

    /// @notice Quote a two-hop exact-input swap tokenIn -> USDC -> tokenOut.
    function quoteExactInputThroughUsdc(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        external
        returns (uint256 amountOut)
    {
        uint256 usdcMid = quoteExactInputSingle(tokenIn, USDC, fee, amountIn);
        amountOut = quoteExactInputSingle(USDC, tokenOut, fee, usdcMid);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external view override {
        bool zeroForOne = abi.decode(data, (bool));
        // Output is the negative delta of the OUT token.
        uint256 amountOut = zeroForOne ? uint256(-amount1Delta) : uint256(-amount0Delta);
        // Revert with the amount so the quote function can read it without state change.
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, amountOut)
            revert(ptr, 32)
        }
    }

    function _parseRevert(bytes memory reason) private pure returns (uint256) {
        require(reason.length == 32, "BAD_QUOTE");
        return abi.decode(reason, (uint256));
    }
}
