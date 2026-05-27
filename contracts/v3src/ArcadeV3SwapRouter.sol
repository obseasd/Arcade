// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title ArcadeV3SwapRouter
 * @notice Minimal exact-input swap router for Arcade's Uniswap V3 pools. Built
 *         in 0.7.6 with no OpenZeppelin dependency (manual ERC20 calls) so it
 *         deploys cleanly on Arc without the full V3 periphery (which needs
 *         WETH9 + an incompatible OZ version). Supports a single hop
 *         (token <-> USDC) and a two-hop route (tokenIn -> USDC -> tokenOut).
 *
 *         Users approve THIS router for the input token. The swap callback is
 *         authenticated against the canonical factory so only real pools can
 *         pull funds.
 */
contract ArcadeV3SwapRouter is IUniswapV3SwapCallback {
    address public immutable factory;
    address public immutable USDC;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    struct SwapCallbackData {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address payer;
    }

    constructor(address factory_, address usdc_) {
        require(factory_ != address(0) && usdc_ != address(0), "ZERO");
        factory = factory_;
        USDC = usdc_;
    }

    /// @notice Swap an exact `amountIn` of `tokenIn` for `tokenOut` in a single
    /// pool of the given `fee` tier. Output goes to `recipient`.
    function exactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "EXPIRED");
        amountOut = _swap(
            SwapCallbackData({tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, payer: msg.sender}),
            amountIn,
            recipient
        );
        require(amountOut >= amountOutMinimum, "INSUFFICIENT_OUTPUT");
    }

    /// @notice Swap `tokenIn` -> USDC -> `tokenOut` (both legs at `fee`).
    function exactInputThroughUsdc(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "EXPIRED");
        // Leg 1: tokenIn -> USDC, output held by this router.
        uint256 usdcMid = _swap(
            SwapCallbackData({tokenIn: tokenIn, tokenOut: USDC, fee: fee, payer: msg.sender}),
            amountIn,
            address(this)
        );
        // Leg 2: USDC -> tokenOut, paid by this router, delivered to recipient.
        amountOut = _swap(
            SwapCallbackData({tokenIn: USDC, tokenOut: tokenOut, fee: fee, payer: address(this)}),
            usdcMid,
            recipient
        );
        require(amountOut >= amountOutMinimum, "INSUFFICIENT_OUTPUT");
    }

    function _swap(SwapCallbackData memory d, uint256 amountIn, address recipient)
        internal
        returns (uint256 amountOut)
    {
        address pool = IUniswapV3Factory(factory).getPool(d.tokenIn, d.tokenOut, d.fee);
        require(pool != address(0), "NO_POOL");
        bool zeroForOne = d.tokenIn < d.tokenOut;
        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
            recipient,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(d)
        );
        amountOut = uint256(-(zeroForOne ? amount1 : amount0));
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        SwapCallbackData memory d = abi.decode(data, (SwapCallbackData));
        // Authenticate: msg.sender must be the canonical pool for these tokens+fee.
        address pool = IUniswapV3Factory(factory).getPool(d.tokenIn, d.tokenOut, d.fee);
        require(msg.sender == pool, "BAD_CALLBACK");

        // We owe the positive delta, always in the input token.
        uint256 amountToPay = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        _pay(d.tokenIn, d.payer, msg.sender, amountToPay);
    }

    function _pay(address token, address payer, address to, uint256 amount) internal {
        bytes memory payload = payer == address(this)
            ? abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount)
            : abi.encodeWithSelector(IERC20Min.transferFrom.selector, payer, to, amount);
        (bool ok, bytes memory ret) = token.call(payload);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "PAY_FAIL");
    }
}
