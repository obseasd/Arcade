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

interface ILaunchpadSnipe {
    function currentSnipeBps(address token) external view returns (uint256);
    function treasury() external view returns (address);
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
    /// @notice Arcade launchpad — read for the anti-sniper tax (0 to disable).
    address public immutable launchpad;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    struct SwapCallbackData {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address payer;
    }

    constructor(address factory_, address usdc_, address launchpad_) {
        require(factory_ != address(0) && usdc_ != address(0), "ZERO");
        factory = factory_;
        USDC = usdc_;
        launchpad = launchpad_; // may be 0 to disable the sniper tax
    }

    /// @dev Anti-sniper skim. Audit V3-3 extended coverage: the original
    /// version only taxed USDC→launchToken buys. Sells (launchToken→USDC)
    /// were free, which gave a team "exit pump" path during the launch
    /// window. The skim is now taken on EITHER direction whenever one
    /// side of the swap is a launchToken under active snipe bps:
    ///   - Buy (USDC→launchToken):  skim X% of USDC input (existing behavior).
    ///   - Sell (launchToken→USDC): skim X% of launchToken input. Treasury
    ///     receives launchToken; can be burned or rolled into LP later.
    /// No-op outside the launch window (bps == 0) or when the launchpad
    /// isn't wired. Cross-token (non-USDC ↔ non-USDC) routes never enter
    /// _snipeSkim because the swap router never sees them at the single-
    /// hop entry; exactInputThroughUsdc explicitly applies the skim on
    /// the USDC mid for those cases.
    function _snipeSkim(address tokenIn, address tokenOut, uint256 amountIn, address payer)
        internal
        returns (uint256 skim)
    {
        if (launchpad == address(0)) return 0;
        if (tokenIn == USDC) {
            uint256 bps = ILaunchpadSnipe(launchpad).currentSnipeBps(tokenOut);
            if (bps == 0) return 0;
            skim = (amountIn * bps) / 10000;
            if (skim > 0) _pay(USDC, payer, ILaunchpadSnipe(launchpad).treasury(), skim);
            return skim;
        }
        // Sell-side: tokenIn might be a launchpad token under snipe. The
        // launchpad keys snipe by token address; we look it up directly.
        // Skim is in tokenIn units so the swap proceeds with the
        // remainder; treasury holds the launchToken.
        uint256 sellBps = ILaunchpadSnipe(launchpad).currentSnipeBps(tokenIn);
        if (sellBps == 0) return 0;
        skim = (amountIn * sellBps) / 10000;
        if (skim > 0) _pay(tokenIn, payer, ILaunchpadSnipe(launchpad).treasury(), skim);
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
        uint256 skim = _snipeSkim(tokenIn, tokenOut, amountIn, msg.sender);
        amountOut = _swap(
            SwapCallbackData({tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, payer: msg.sender}),
            amountIn - skim,
            recipient
        );
        require(amountOut >= amountOutMinimum, "INSUFFICIENT_OUTPUT");
    }

    /// @notice Swap `tokenIn` -> USDC -> `tokenOut` (both legs at `fee`).
    /// @dev Apply the anti-sniper skim between leg 1 (which mints USDC into
    /// this router) and leg 2 (which buys `tokenOut`). Without this, snipers
    /// could bypass the launch-window tax by routing through any non-USDC
    /// asset (eg WETH -> USDC -> launchToken). Skim is taken from the router's
    /// own USDC mid-balance and forwarded to the launchpad treasury.
    function exactInputThroughUsdc(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 usdcMidMin,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "EXPIRED");
        // Leg 1: tokenIn -> USDC, output held by this router.
        uint256 usdcMid = _swap(
            SwapCallbackData({tokenIn: tokenIn, tokenOut: USDC, fee: fee, payer: msg.sender}),
            amountIn,
            address(this)
        );
        // Audit low [5]: cap the mid-leg slippage independently of the
        // final amountOutMinimum. A sandwicher who can move only the
        // tokenIn/USDC pool (eg by sweeping a related thin pair on the
        // same block) can drive usdcMid arbitrarily low, then the
        // smoothing of leg 2's lower input against an unchanged
        // USDC/tokenOut pool can still produce an amountOut that scrapes
        // past amountOutMinimum. usdcMidMin closes that loophole.
        require(usdcMid >= usdcMidMin, "MID_SLIPPAGE");
        // Anti-sniper skim: paid by the router from its own mid-balance.
        uint256 skim = _snipeSkim(USDC, tokenOut, usdcMid, address(this));
        // Leg 2: USDC -> tokenOut, paid by this router, delivered to recipient.
        amountOut = _swap(
            SwapCallbackData({tokenIn: USDC, tokenOut: tokenOut, fee: fee, payer: address(this)}),
            usdcMid - skim,
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
        // Audit low [0]: mirror the M-14 fix already applied in the Locker
        // (ArcadeV3Locker._pay). A token that returns 1-31 bytes (legal but
        // non-canonical) would otherwise trigger Panic 0x32 from abi.decode
        // instead of the intended PAY_FAIL revert. The explicit
        // `ret.length >= 32` gate keeps the require's reason string
        // reachable.
        require(
            ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool)))),
            "PAY_FAIL"
        );
    }
}
