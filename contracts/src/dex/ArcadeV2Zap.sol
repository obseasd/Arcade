// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
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
 *         pair on the auto-converted leg, mirroring the HyperSwap-style zap
 *         our /positions/add UI advertises.
 *
 *         The pair MUST exist before zap is callable. For the first liquidity
 *         provider, use the router's `addLiquidity` directly (no swap path).
 *
 * @dev Audit HIGH fix (2026-06-06): the prior INTERNAL_SWAP_SLIP_BPS guard
 *      computed `expectedOut` from the same in-tx reserves the router used
 *      and was therefore structurally a no-op against sandwich attacks (both
 *      sides of the comparison are derived from the already-poisoned
 *      reserves). The fix shifts the sandwich defense to a CALLER-SIGNED
 *      `amountOtherMin` derived from off-chain pre-tx reserves and slippage
 *      tolerance: the frontend reads reserves at block N, applies the user's
 *      slippage, signs the tx. If a sandwicher poisons reserves between block
 *      N and our tx, the router's actual `amounts[1]` falls below the
 *      caller-signed floor and the tx reverts.
 *
 * @dev Audit MEDIUM fix (2026-06-06): the dust sweep used to forward the
 *      contract's ENTIRE balance instead of only the residual from THIS
 *      call. Because audit-low [12] leaves stuck dust on the contract when
 *      sweep fails (blocklisted recipient), the next caller would inherit
 *      that dust. We now snapshot pre-pull balances and sweep deltas only.
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
    error InsufficientSwapOutput();
    error InsufficientOutput();
    error ExcessiveAmountIn();
    error ZeroSlippageGuard();

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
     * @param amountOtherMin Caller-signed minimum tokenOther output from the
     *        internal swap leg. MUST be computed off-chain from pre-tx
     *        reserves + user's slippage tolerance. This is the SOLE sandwich
     *        defense for the swap leg.
     * @param amountLpMin Minimum LP tokens to mint, slippage guard for the
     *        addLiquidity step. Use 0 to skip (the router's internal min
     *        already protects against the LP minted being non-zero).
     * @param to Address that receives the LP tokens.
     * @param deadline Tx-revert deadline (UNIX seconds).
     * @return liquidity LP tokens minted to `to`.
     */
    function zapIn(
        address tokenIn,
        uint256 amountIn,
        address tokenOther,
        uint256 amountOtherMin,
        uint256 amountLpMin,
        address to,
        uint256 deadline
    ) external returns (uint256 liquidity) {
        return _zapIn(
            msg.sender, tokenIn, amountIn, tokenOther,
            amountOtherMin, amountLpMin, to, deadline
        );
    }

    function _zapIn(
        address payer,
        address tokenIn,
        uint256 amountIn,
        address tokenOther,
        uint256 amountOtherMin,
        uint256 amountLpMin,
        address to,
        uint256 deadline
    ) internal returns (uint256 liquidity) {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0 || tokenIn == tokenOther) revert InvalidInput();
        // amountOtherMin == 0 would skip the sandwich defense entirely and
        // is almost always a frontend bug. Audit LOW [7] companion fix.
        if (amountOtherMin == 0) revert ZeroSlippageGuard();

        address pair = IArcadeV2Factory(factory).getPair(tokenIn, tokenOther);
        if (pair == address(0)) revert PairNotFound();

        // MEDIUM fix: snapshot pre-pull balances of both legs so the post-zap
        // dust sweep can target only the residual from THIS call rather than
        // forwarding any accumulated stuck balance from prior failed sweeps
        // (or accidental donations).
        uint256 balBeforeIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 balBeforeOther = IERC20(tokenOther).balanceOf(address(this));

        // Pull funds from the payer (= msg.sender on the public zapIn entry,
        // = the original user on zapInWithPermit).
        IERC20(tokenIn).safeTransferFrom(payer, address(this), amountIn);

        // Determine the reserves of the tokenIn side. The pair stores reserves
        // sorted by (token0, token1); align them with the caller's perspective.
        // Single read - audit LOW [3] companion fix: the prior code called
        // _orientedReserves twice and discarded half of each result.
        (uint256 reserveIn, uint256 reserveOther) =
            _orientedReserves(pair, tokenIn, tokenOther);
        if (reserveIn == 0 || reserveOther == 0) revert EmptyReserves();

        // Audit LOW [6] companion fix: bound amountIn vs reserveIn so the
        // closed-form math stays in its well-behaved regime. Beyond ~100x
        // the reserves the user owns essentially the entire pool anyway
        // and the dust sweep recovers most value; refusing the trade with
        // a clear error beats a silent quadratic-overflow revert deep in
        // _calcSwapAmount.
        if (amountIn > reserveIn * 100) revert ExcessiveAmountIn();

        // Optimal split: how much of amountIn to swap so the resulting balance
        // matches the post-swap pair ratio. Derived for the V2 invariant with
        // the standard 0.30% fee (997/1000 of input becomes effective).
        uint256 swapAmount = _calcSwapAmount(reserveIn, amountIn);

        // Swap the calculated chunk through the router with the CALLER-SIGNED
        // floor. The router itself enforces amounts[1] >= amountOtherMin; the
        // explicit post-check below is defensive in case a forked router
        // ignores its own min.
        IERC20(tokenIn).forceApprove(router, swapAmount);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOther;
        uint256[] memory amounts = IArcadeV2Router(router).swapExactTokensForTokens(
            swapAmount,
            amountOtherMin,
            path,
            address(this),
            deadline
        );
        uint256 otherReceived = amounts[1];
        if (otherReceived < amountOtherMin) revert InsufficientSwapOutput();

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

        // Audit LOW [8] companion fix: zero the router allowances after the
        // calls have consumed what they need. The router is `immutable` and
        // its pull paths only touch our balance via msg.sender == this, so
        // there's no realistic exploit path for a stale allowance, but
        // belt-and-braces hygiene is cheap.
        IERC20(tokenIn).forceApprove(router, 0);
        IERC20(tokenOther).forceApprove(router, 0);

        // Sweep any DELTA dust caused by rounding so nothing stays parked here.
        // Audit MEDIUM fix: subtract pre-pull balance from current so a stuck
        // residual from a previous tx's failed sweep can't be picked up by
        // the current caller. Audit LOW [12] try/catch wrapping is preserved
        // so a blocklisted recipient does not roll back the whole zap.
        uint256 balAfterIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 dustIn = balAfterIn > balBeforeIn ? balAfterIn - balBeforeIn : 0;
        if (dustIn > 0) {
            try this.sweep(tokenIn, to, dustIn) {} catch {
                /* skip - sweep blocked, dust remains on the zap */
            }
        }
        uint256 balAfterOther = IERC20(tokenOther).balanceOf(address(this));
        uint256 dustOther =
            balAfterOther > balBeforeOther ? balAfterOther - balBeforeOther : 0;
        if (dustOther > 0) {
            try this.sweep(tokenOther, to, dustOther) {} catch {
                /* skip - sweep blocked, dust remains on the zap */
            }
        }
    }

    /**
     * @notice One-tx zap with an EIP-2612 permit signature on tokenIn,
     *         skipping the separate approve tx. Halves the user signature
     *         count and saves ~45k gas on the first interaction.
     * @dev Wraps the permit call in try/catch (OZ's recommended pattern):
     *      a frontrunner can replay the permit between the user's signing
     *      and our broadcast, which would make `permit` revert. We tolerate
     *      that and fall through to safeTransferFrom, which will succeed
     *      with the allowance the frontrunner just set on our behalf.
     */
    function zapInWithPermit(
        address tokenIn,
        uint256 amountIn,
        address tokenOther,
        uint256 amountOtherMin,
        uint256 amountLpMin,
        address to,
        uint256 deadline,
        // EIP-2612 permit params (signed by msg.sender for tokenIn)
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 liquidity) {
        try IERC20Permit(tokenIn).permit(
            msg.sender, address(this), amountIn, permitDeadline, v, r, s
        ) {} catch {
            /* permit replayed or token doesn't support EIP-2612; fall through
             * to safeTransferFrom which will revert if the user truly has no
             * allowance. */
        }
        return _zapIn(
            msg.sender, tokenIn, amountIn, tokenOther,
            amountOtherMin, amountLpMin, to, deadline
        );
    }

    /**
     * @notice Single-asset withdraw from a V2 pair. Burns LP, then swaps the
     *         non-tokenOut leg through the same pair so the user gets one
     *         consolidated balance instead of two.
     * @param tokenOther The non-tokenOut side of the pair (the leg the zap
     *        will swap away). Must be the actual paired token.
     * @param amountOtherMin Caller-signed minimum tokenOut output from the
     *        internal swap leg. Same sandwich-defense pattern as zapIn.
     *        Set to 0 to skip the swap entirely (zap returns dual-leg).
     * @param amountOutMin Total tokenOut the caller must receive (LP burn
     *        side + swap output). Enforced at the end.
     * @return amountOut Total tokenOut sent to `to`.
     */
    function zapOut(
        address tokenOut,
        address tokenOther,
        uint256 liquidityIn,
        uint256 amountOtherMin,
        uint256 amountOutMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (liquidityIn == 0 || tokenOut == tokenOther) revert InvalidInput();

        address pair = IArcadeV2Factory(factory).getPair(tokenOut, tokenOther);
        if (pair == address(0)) revert PairNotFound();

        // Delta-sweep snapshot - same pattern as zapIn so dust from prior
        // failed sweeps can't be picked up by this caller.
        uint256 balBeforeOut = IERC20(tokenOut).balanceOf(address(this));
        uint256 balBeforeOther = IERC20(tokenOther).balanceOf(address(this));

        // Pull LP from the user, then burn via the router.
        IERC20(pair).safeTransferFrom(msg.sender, address(this), liquidityIn);
        IERC20(pair).forceApprove(router, liquidityIn);
        (uint256 receivedOut, uint256 receivedOther) = IArcadeV2Router(router).removeLiquidity(
            tokenOut,
            tokenOther,
            liquidityIn,
            0, // amountOutMin enforced at end against the SUM
            0, // amountOtherMin gated below at the swap step
            address(this),
            deadline
        );

        // Swap the non-tokenOut side back to tokenOut via the same pair, if
        // we actually received any (out-of-range burns can leave one leg at 0).
        uint256 swapOut = 0;
        if (receivedOther > 0 && amountOtherMin > 0) {
            IERC20(tokenOther).forceApprove(router, receivedOther);
            address[] memory path = new address[](2);
            path[0] = tokenOther;
            path[1] = tokenOut;
            uint256[] memory amounts = IArcadeV2Router(router).swapExactTokensForTokens(
                receivedOther,
                amountOtherMin,
                path,
                address(this),
                deadline
            );
            swapOut = amounts[1];
            if (swapOut < amountOtherMin) revert InsufficientSwapOutput();
            IERC20(tokenOther).forceApprove(router, 0);
        }

        amountOut = receivedOut + swapOut;
        if (amountOut < amountOutMin) revert InsufficientOutput();

        // Direct transfer to user. Reverts cleanly if `to` is blocklisted -
        // that's the right behaviour for a withdraw (the user is asking us
        // to send tokens; if they can't receive, the whole thing must roll
        // back so they get their LP back).
        IERC20(tokenOut).safeTransfer(to, amountOut);

        // Delta dust sweep on any residual tokenOther (skipped swap branch
        // when amountOtherMin == 0, or rounding leftovers).
        uint256 balAfterOther = IERC20(tokenOther).balanceOf(address(this));
        uint256 dustOther =
            balAfterOther > balBeforeOther ? balAfterOther - balBeforeOther : 0;
        if (dustOther > 0) {
            try this.sweep(tokenOther, to, dustOther) {} catch {
                /* skip - blocklisted, dust stays on the zap */
            }
        }
        // tokenOut shouldn't have residual after the explicit transfer above,
        // but check anyway in case the router quoted high.
        uint256 balAfterOut = IERC20(tokenOut).balanceOf(address(this));
        uint256 dustOut = balAfterOut > balBeforeOut ? balAfterOut - balBeforeOut : 0;
        if (dustOut > 0) {
            try this.sweep(tokenOut, to, dustOut) {} catch {}
        }
    }

    /**
     * @notice External self-call wrapper so the dust sweep can be guarded by
     *         try/catch. Solidity does not allow try/catch on internal
     *         function calls.
     */
    function sweep(address token, address to, uint256 amount) external {
        require(msg.sender == address(this), "self-only");
        IERC20(token).safeTransfer(to, amount);
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
     *      Magic constants:
     *        3988009 = 1997^2     (= (2*997 + 3)^2 in V2's 997/1000 fee form)
     *        3988000 = 4*997*1000 (cross term in the quadratic discriminant)
     *        1997    = 2*997 + 3  (linear coefficient inside the sqrt arg)
     *        1994    = 2*997      (denominator after isolating s)
     *
     *      The full derivation expands (reserveIn + 997*s/1000)^2 = r * (r + amountIn)
     *      so that the constant-product invariant rebalances around the
     *      post-swap reserves; rearranging for s yields the closed form above.
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
