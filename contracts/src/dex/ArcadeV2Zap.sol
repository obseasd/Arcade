// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArcadeV2Factory} from "./interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Pair} from "./interfaces/IArcadeV2Pair.sol";
import {IArcadeV2Router} from "./interfaces/IArcadeV2Router.sol";

/**
 * @title ArcadeV2Zap
 * @notice Single-asset add-liquidity helper for the Arcade V2 AMM. Accepts a
 *         deposit denominated in one side of a pair, runs the optimal swap
 *         against the pair itself to source the other side, then forwards
 *         both legs to the router's addLiquidity. LP tokens land in `to`.
 *
 *         No extra protocol fee on top of the 0.30% swap fee charged by the
 *         pair on the auto-converted leg — this matches the HyperSwap zap
 *         behaviour our /positions/add UI advertises.
 *
 *         The pair MUST exist before zap is callable. For the first liquidity
 *         provider, use the router's `addLiquidity` directly (no swap path).
 */
contract ArcadeV2Zap {
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable router;

    error Expired();
    error PairNotFound();
    error EmptyReserves();
    error InvalidInput();
    error InsufficientLiquidityMinted();

    constructor(address _factory, address _router) {
        if (_factory == address(0) || _router == address(0)) revert InvalidInput();
        factory = _factory;
        router = _router;
    }

    /**
     * @notice Zap a single asset into an existing pair.
     * @param tokenIn The asset the user is depositing.
     * @param amountIn Amount of tokenIn to pull from `msg.sender`.
     * @param tokenOther The other side of the pair.
     * @param amountLpMin Minimum LP tokens to mint, slippage guard.
     * @param to Address that receives the LP tokens.
     * @param deadline Tx-revert deadline (UNIX seconds).
     * @return liquidity LP tokens minted to `to`.
     */
    function zapIn(
        address tokenIn,
        uint256 amountIn,
        address tokenOther,
        uint256 amountLpMin,
        address to,
        uint256 deadline
    ) external returns (uint256 liquidity) {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0 || tokenIn == tokenOther) revert InvalidInput();

        address pair = IArcadeV2Factory(factory).getPair(tokenIn, tokenOther);
        if (pair == address(0)) revert PairNotFound();

        // Pull funds from the user.
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Determine the reserves of the tokenIn side. The pair stores reserves
        // sorted by (token0, token1); align them with the caller's perspective.
        (uint256 reserveIn, ) = _orientedReserves(pair, tokenIn, tokenOther);
        if (reserveIn == 0) revert EmptyReserves();

        // Optimal split: how much of amountIn to swap so the resulting balance
        // matches the post-swap pair ratio. Derived for the V2 invariant with
        // the standard 0.30% fee (997/1000 of input becomes effective).
        uint256 swapAmount = _calcSwapAmount(reserveIn, amountIn);

        // Swap the calculated chunk through the router.
        IERC20(tokenIn).forceApprove(router, swapAmount);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOther;
        uint256[] memory amounts = IArcadeV2Router(router).swapExactTokensForTokens(
            swapAmount,
            0,
            path,
            address(this),
            deadline
        );
        uint256 otherReceived = amounts[1];

        // Deposit the remainder of tokenIn + the swap output as liquidity.
        uint256 remainingIn = amountIn - swapAmount;
        IERC20(tokenIn).forceApprove(router, remainingIn);
        IERC20(tokenOther).forceApprove(router, otherReceived);

        (, , liquidity) = IArcadeV2Router(router).addLiquidity(
            tokenIn,
            tokenOther,
            remainingIn,
            otherReceived,
            0,
            0,
            to,
            deadline
        );

        if (liquidity < amountLpMin) revert InsufficientLiquidityMinted();

        // Sweep any dust caused by rounding so nothing stays parked here.
        uint256 dustIn = IERC20(tokenIn).balanceOf(address(this));
        if (dustIn > 0) IERC20(tokenIn).safeTransfer(to, dustIn);
        uint256 dustOther = IERC20(tokenOther).balanceOf(address(this));
        if (dustOther > 0) IERC20(tokenOther).safeTransfer(to, dustOther);
    }

    /**
     * @notice Preview the swap split and expected LP for a zapIn call. Useful
     *         for the UI to render the quote before the user signs.
     * @return swapAmount Portion of amountIn the zap will swap.
     * @return otherOut Estimated tokenOther received from that swap.
     * @return lpEstimate Estimated LP that will be minted, before slippage.
     */
    function quoteZapIn(
        address tokenIn,
        uint256 amountIn,
        address tokenOther
    ) external view returns (uint256 swapAmount, uint256 otherOut, uint256 lpEstimate) {
        address pair = IArcadeV2Factory(factory).getPair(tokenIn, tokenOther);
        if (pair == address(0)) return (0, 0, 0);

        (uint256 reserveIn, uint256 reserveOther) = _orientedReserves(pair, tokenIn, tokenOther);
        if (reserveIn == 0 || reserveOther == 0) return (0, 0, 0);

        swapAmount = _calcSwapAmount(reserveIn, amountIn);
        uint256 amountInWithFee = swapAmount * 997;
        otherOut = (amountInWithFee * reserveOther) / (reserveIn * 1000 + amountInWithFee);

        uint256 newReserveIn = reserveIn + swapAmount;
        uint256 newReserveOther = reserveOther - otherOut;
        uint256 totalSupply = IArcadeV2Pair(pair).totalSupply();
        uint256 remainingIn = amountIn - swapAmount;
        uint256 lpFromIn = (remainingIn * totalSupply) / newReserveIn;
        uint256 lpFromOther = (otherOut * totalSupply) / newReserveOther;
        lpEstimate = lpFromIn < lpFromOther ? lpFromIn : lpFromOther;
    }

    // ----- internals --------------------------------------------------------

    function _orientedReserves(
        address pair,
        address tokenIn,
        address tokenOther
    ) internal view returns (uint256 reserveIn, uint256 reserveOther) {
        (address token0, ) = tokenIn < tokenOther ? (tokenIn, tokenOther) : (tokenOther, tokenIn);
        (uint112 r0, uint112 r1, ) = IArcadeV2Pair(pair).getReserves();
        if (tokenIn == token0) {
            reserveIn = uint256(r0);
            reserveOther = uint256(r1);
        } else {
            reserveIn = uint256(r1);
            reserveOther = uint256(r0);
        }
    }

    /**
     * @dev Optimal swap-in amount for a one-sided deposit, accounting for the
     *      0.30% fee. Solves for `s` such that after swapping `s` of token A
     *      the remaining (amountIn - s) of A and the resulting B balance the
     *      pair's new ratio:
     *
     *        s = (sqrt(r * (r * 3988009 + amountIn * 3988000)) - r * 1997) / 1994
     *
     *      The magic constants come from expanding (r + 997s/1000)^2 / r^2.
     */
    function _calcSwapAmount(uint256 reserveIn, uint256 amountIn) internal pure returns (uint256) {
        uint256 inner = reserveIn * (reserveIn * 3988009 + amountIn * 3988000);
        uint256 root = _sqrt(inner);
        return (root - reserveIn * 1997) / 1994;
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
