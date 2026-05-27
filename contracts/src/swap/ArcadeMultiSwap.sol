// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IArcadeV2Factory} from "../dex/interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Router} from "../dex/interfaces/IArcadeV2Router.sol";
import {IArcadeLaunchpad} from "../launchpad/interfaces/IArcadeLaunchpad.sol";

/**
 * @title ArcadeMultiSwap
 * @notice Atomic N-input -> 1-output swap router. Each input is routed
 *         independently to the chosen output token in the same transaction,
 *         and the totalled output is delivered to the caller.
 *
 *         Per-input routing matches the SwapCard single-swap behaviour:
 *           1. tokenIn == tokenOut         -> passthrough (no swap, no fee)
 *           2. USDC on either side          -> direct V2 swap
 *           3. direct A<->B pool exists     -> direct V2 swap
 *           4. either side is migrated lp   -> launchpad.swapMigratedRoute
 *                                              (so royalty is paid on each
 *                                              migrated leg of A->USDC->B)
 *           5. otherwise                    -> V2 multi-hop via USDC
 *
 *         No additional fee is charged by this router on top of the underlying
 *         routes; it only orchestrates approvals and accumulates outputs.
 */
contract ArcadeMultiSwap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    IArcadeV2Factory public immutable v2Factory;
    IArcadeV2Router public immutable v2Router;
    IArcadeLaunchpad public immutable launchpad;

    /// @dev Cap to keep gas predictable and prevent malicious "long-list" calls.
    uint256 public constant MAX_INPUTS = 8;

    struct Input {
        address token;
        uint256 amount;
    }

    error EmptyInputs();
    error TooManyInputs();
    error DeadlinePassed();
    error InsufficientOutput();
    error ZeroAmount();
    error ZeroAddress();

    event MultiSwap(
        address indexed sender,
        address indexed tokenOut,
        uint256 inputsCount,
        uint256 totalOut
    );

    constructor(
        IERC20 usdc_,
        IArcadeV2Factory v2Factory_,
        IArcadeV2Router v2Router_,
        IArcadeLaunchpad launchpad_
    ) {
        if (
            address(usdc_) == address(0)
                || address(v2Factory_) == address(0)
                || address(v2Router_) == address(0)
                || address(launchpad_) == address(0)
        ) revert ZeroAddress();
        USDC = usdc_;
        v2Factory = v2Factory_;
        v2Router = v2Router_;
        launchpad = launchpad_;
    }

    /**
     * @notice Swap N inputs to a single output token atomically.
     * @param inputs       list of (token, amount) pairs to swap
     * @param tokenOut     the destination token
     * @param minTotalOut  revert if the accumulated output is below this
     * @param deadline     unix timestamp after which the call reverts
     * @return totalOut    total amount of `tokenOut` delivered to msg.sender
     */
    function swapToSingle(
        Input[] calldata inputs,
        address tokenOut,
        uint256 minTotalOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 totalOut) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (inputs.length == 0) revert EmptyInputs();
        if (inputs.length > MAX_INPUTS) revert TooManyInputs();
        if (tokenOut == address(0)) revert ZeroAddress();

        for (uint256 i; i < inputs.length; ++i) {
            Input calldata inp = inputs[i];
            if (inp.token == address(0)) revert ZeroAddress();
            if (inp.amount == 0) revert ZeroAmount();

            // Same-token input: pull and pass straight through. No router fee.
            if (inp.token == tokenOut) {
                IERC20(tokenOut).safeTransferFrom(msg.sender, address(this), inp.amount);
                totalOut += inp.amount;
                continue;
            }

            IERC20(inp.token).safeTransferFrom(msg.sender, address(this), inp.amount);
            totalOut += _routeOne(inp.token, tokenOut, inp.amount);
        }

        if (totalOut < minTotalOut) revert InsufficientOutput();

        IERC20(tokenOut).safeTransfer(msg.sender, totalOut);

        emit MultiSwap(msg.sender, tokenOut, inputs.length, totalOut);
    }

    /// @dev Picks the best route for a single (tokenIn -> tokenOut) leg and
    /// executes it. Output is sent to `address(this)` so the caller can
    /// accumulate before forwarding.
    function _routeOne(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        // 1) Direct V2 path: USDC pivot or an explicit A<->B pool exists.
        bool oneSideUsdc = tokenIn == address(USDC) || tokenOut == address(USDC);
        if (oneSideUsdc || v2Factory.getPair(tokenIn, tokenOut) != address(0)) {
            return _swapV2(tokenIn, tokenOut, amountIn, /*viaUsdc=*/ false);
        }

        // 2) Multi-hop via USDC. If at least one side is a migrated launchpad
        // token, route through the launchpad so the royalty is paid; otherwise
        // a plain V2 multi-hop is enough.
        bool inMigrated = launchpad.isMigrated(tokenIn);
        bool outMigrated = launchpad.isMigrated(tokenOut);
        if (inMigrated || outMigrated) {
            IERC20(tokenIn).forceApprove(address(launchpad), amountIn);
            return launchpad.swapMigratedRoute(tokenIn, tokenOut, amountIn, 0);
        }

        return _swapV2(tokenIn, tokenOut, amountIn, /*viaUsdc=*/ true);
    }

    /// @dev Helper for the two V2 paths (direct or via USDC).
    function _swapV2(address tokenIn, address tokenOut, uint256 amountIn, bool viaUsdc)
        internal
        returns (uint256)
    {
        IERC20(tokenIn).forceApprove(address(v2Router), amountIn);
        address[] memory path;
        if (viaUsdc) {
            path = new address[](3);
            path[0] = tokenIn;
            path[1] = address(USDC);
            path[2] = tokenOut;
        } else {
            path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
        }
        uint256[] memory amounts = v2Router.swapExactTokensForTokens(
            amountIn, 0, path, address(this), block.timestamp + 600
        );
        return amounts[path.length - 1];
    }

    // ====================== Views ======================

    /**
     * @notice View quote that mirrors `swapToSingle`. Returns the expected
     * total output and a parallel array of per-input outputs so the UI can
     * highlight which legs contribute most. Pure-view: does not change state.
     */
    function quoteSwapToSingle(Input[] calldata inputs, address tokenOut)
        external
        view
        returns (uint256 totalOut, uint256[] memory perInputOut)
    {
        perInputOut = new uint256[](inputs.length);
        for (uint256 i; i < inputs.length; ++i) {
            Input calldata inp = inputs[i];
            if (inp.amount == 0 || inp.token == address(0)) continue;
            if (inp.token == tokenOut) {
                perInputOut[i] = inp.amount;
                totalOut += inp.amount;
                continue;
            }
            uint256 outI = _quoteOne(inp.token, tokenOut, inp.amount);
            perInputOut[i] = outI;
            totalOut += outI;
        }
    }

    function _quoteOne(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        bool oneSideUsdc = tokenIn == address(USDC) || tokenOut == address(USDC);
        if (oneSideUsdc || v2Factory.getPair(tokenIn, tokenOut) != address(0)) {
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            try v2Router.getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
                return amounts[1];
            } catch {
                return 0;
            }
        }
        bool inMigrated = launchpad.isMigrated(tokenIn);
        bool outMigrated = launchpad.isMigrated(tokenOut);
        if (inMigrated || outMigrated) {
            // Defer to the launchpad's royalty-aware quote helper.
            try launchpad.quoteSwapMigratedRoute(tokenIn, tokenOut, amountIn) returns (
                uint256 tokensOut,
                uint256 /*royalty*/
            ) {
                return tokensOut;
            } catch {
                return 0;
            }
        }
        address[] memory pathH = new address[](3);
        pathH[0] = tokenIn;
        pathH[1] = address(USDC);
        pathH[2] = tokenOut;
        try v2Router.getAmountsOut(amountIn, pathH) returns (uint256[] memory amounts) {
            return amounts[2];
        } catch {
            return 0;
        }
    }
}
