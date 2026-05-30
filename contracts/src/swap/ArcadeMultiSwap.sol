// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IArcadeV2Factory} from "../dex/interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Router} from "../dex/interfaces/IArcadeV2Router.sol";
import {IArcadeLaunchpad} from "../launchpad/interfaces/IArcadeLaunchpad.sol";
import {IArcadeV3Router} from "../v3/interfaces/IArcadeV3Minimal.sol";

interface ILaunchpadExtra {
    /// @notice Returns true if `token` is a launchpad token that uses the V3
    /// path (Clanker V3 launches — no V2 pair, traded directly on V3 from
    /// birth). The launchpad sets this when the V3 router is wired.
    function isMigrated(address token) external view returns (bool);
}

/**
 * @title ArcadeMultiSwap
 * @notice Atomic N-input -> 1-output swap router. Each input is routed
 *         independently to the chosen output token in the same transaction,
 *         and the totalled output is delivered to the caller.
 *
 *         Per-input routing matches the SwapCard single-swap behaviour:
 *           1. tokenIn == tokenOut         -> passthrough (no swap, no fee)
 *           2. Either side is a Clanker V3 launch token (no V2 pair):
 *              route through the V3 router (single hop if the other side
 *              is USDC, two-hop pivoting through USDC otherwise).
 *           3. Either side is a curve-migrated launchpad token with a V2
 *              pair: route through launchpad.swapMigratedRoute so the
 *              royalty is paid on each migrated leg.
 *           4. USDC on either side OR direct A<->B pool exists: direct V2.
 *           5. Otherwise: V2 multi-hop via USDC.
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
    /// @notice ArcadeV3SwapRouter — required to route Clanker V3 launch tokens.
    /// May be the zero address on deployments that don't use V3.
    IArcadeV3Router public immutable v3Router;
    /// @notice V3 fee tier used for all Clanker V3 pools (1%). Matches the
    /// launchpad constant.
    uint24 public constant V3_FEE = 10_000;

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
        IArcadeLaunchpad launchpad_,
        IArcadeV3Router v3Router_
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
        v3Router = v3Router_; // may be address(0) on deployments without V3
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
            totalOut += _routeOne(inp.token, tokenOut, inp.amount, deadline);
        }

        if (totalOut < minTotalOut) revert InsufficientOutput();

        IERC20(tokenOut).safeTransfer(msg.sender, totalOut);

        emit MultiSwap(msg.sender, tokenOut, inputs.length, totalOut);
    }

    /// @dev Returns true iff `token` is a launchpad token that has no V2 pair
    /// (ie a Clanker V3 launch). We treat this as "V3 token" — must route via
    /// the V3 router, not the V2 path.
    function _isV3LaunchToken(address token) internal view returns (bool) {
        if (!launchpad.isMigrated(token)) return false;
        return v2Factory.getPair(token, address(USDC)) == address(0);
    }

    /// @dev Picks the best route for a single (tokenIn -> tokenOut) leg and
    /// executes it. Output is sent to `address(this)` so the caller can
    /// accumulate before forwarding.
    function _routeOne(address tokenIn, address tokenOut, uint256 amountIn, uint256 deadline) internal returns (uint256) {
        // 1) Clanker V3 launches have no V2 pair — route via the V3 router.
        bool inIsV3 = _isV3LaunchToken(tokenIn);
        bool outIsV3 = _isV3LaunchToken(tokenOut);
        if (inIsV3 || outIsV3) {
            return _swapV3(tokenIn, tokenOut, amountIn, deadline);
        }

        // 2) Direct V2 path: USDC pivot or an explicit A<->B pool exists.
        bool oneSideUsdc = tokenIn == address(USDC) || tokenOut == address(USDC);
        if (oneSideUsdc || v2Factory.getPair(tokenIn, tokenOut) != address(0)) {
            return _swapV2(tokenIn, tokenOut, amountIn, /*viaUsdc=*/ false, deadline);
        }

        // 3) Multi-hop via USDC. If at least one side is a curve-migrated
        // launchpad token, route through the launchpad so the royalty is paid;
        // otherwise a plain V2 multi-hop is enough.
        bool inMigrated = launchpad.isMigrated(tokenIn);
        bool outMigrated = launchpad.isMigrated(tokenOut);
        if (inMigrated || outMigrated) {
            IERC20(tokenIn).forceApprove(address(launchpad), amountIn);
            return launchpad.swapMigratedRoute(tokenIn, tokenOut, amountIn, 0, deadline);
        }

        return _swapV2(tokenIn, tokenOut, amountIn, /*viaUsdc=*/ true, deadline);
    }

    /// @dev Helper for the two V2 paths (direct or via USDC).
    function _swapV2(address tokenIn, address tokenOut, uint256 amountIn, bool viaUsdc, uint256 deadline)
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
            amountIn, 0, path, address(this), deadline
        );
        return amounts[path.length - 1];
    }

    /// @dev Route a leg through the V3 router. Single hop if the other side is
    /// USDC (USDC-paired Clanker V3 pool), two-hop pivoting through USDC
    /// otherwise (eg ClankerA -> USDC -> ClankerB).
    function _swapV3(address tokenIn, address tokenOut, uint256 amountIn, uint256 deadline) internal returns (uint256) {
        if (address(v3Router) == address(0)) revert ZeroAddress();
        IERC20(tokenIn).forceApprove(address(v3Router), amountIn);
        if (tokenIn == address(USDC) || tokenOut == address(USDC)) {
            return v3Router.exactInputSingle(tokenIn, tokenOut, V3_FEE, address(this), amountIn, 0, deadline);
        }
        return v3Router.exactInputThroughUsdc(tokenIn, tokenOut, V3_FEE, address(this), amountIn, 0, deadline);
    }

    // ====================== Views ======================

    /**
     * @notice View quote that mirrors `swapToSingle`. Returns the expected
     * total output and a parallel array of per-input outputs so the UI can
     * highlight which legs contribute most. Pure-view: does not change state.
     *
     * Quoting V3 routes requires a live `eth_call` to the V3 quoter (or pool)
     * which we can't do from a pure view here. The UI should call the V3
     * quoter directly for those legs; this view returns 0 for legs that go
     * through V3.
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
        // V3 routes need a separate quoter call (return 0 here, UI fills in).
        if (_isV3LaunchToken(tokenIn) || _isV3LaunchToken(tokenOut)) return 0;

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
