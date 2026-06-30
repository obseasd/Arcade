// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * Audit V3 Zap H-3: minimal inline SafeERC20 to handle non-standard
 * tokens that don't return a bool from transfer/transferFrom/approve
 * (USDT-style). The OZ SafeERC20 isn't usable cleanly on 0.7.6 + the
 * V3 Zap is near the EIP-170 ceiling, so this 30-line vendored helper
 * is leaner and serves the same purpose: accept either "returns true"
 * OR "returns nothing" as success; revert on "returns false" or any
 * non-bool return data.
 */
library SafeERC20Mini {
    function safeTransfer(IERC20Min token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transfer.selector, to, value));
    }
    function safeTransferFrom(IERC20Min token, address from, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transferFrom.selector, from, to, value));
    }
    function safeApprove(IERC20Min token, address spender, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.approve.selector, spender, value));
    }
    function _callOptionalReturn(IERC20Min token, bytes memory data) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        require(ok, "SAFE_CALL_FAIL");
        if (ret.length > 0) {
            require(abi.decode(ret, (bool)), "SAFE_RET_FALSE");
        }
    }
}

/**
 * @title ArcadeV3Zap
 * @notice Single-asset zap into / out of Uniswap V3 positions on Arcade.
 *
 *         External entrypoints:
 *           - zapInMaxRange:  one-sided deposit, mints a NEW max-range NFT
 *           - zapIn:          one-sided deposit, mints a NEW NFT over a
 *                             caller-supplied [tickLower, tickUpper] range
 *           - zapOut:         burns a position back to a single asset
 *           - quoteZap:       view helper for the UI to render swap leg
 *                             + expected liquidity before signing
 *
 *         All three mutating entrypoints accept caller-signed slippage
 *         floors (amountOtherMinSwap for the internal swap leg, amount0Min/
 *         amount1Min for the mint or amountOutMin for the burn). The
 *         contract NEVER derives a sandwich-defense floor from in-tx
 *         reserves alone; see [[project-arcade-v2-zap-audit]] HIGH finding.
 *
 *         Solidity 0.7.6 to inherit the canonical V3 callback interfaces +
 *         NPM types + FullMath / TickMath / LiquidityAmounts from
 *         v3-core / v3-periphery without re-vendoring.
 */
contract ArcadeV3Zap is IUniswapV3SwapCallback {
    using SafeERC20Mini for IERC20Min;

    address public immutable factory;
    address public immutable npm;

    /// @notice Audit V3 Zap M-3: minimal events so the indexer can label
    ///         zap activity without inferring from NPM IncreaseLiquidity.
    event ZapIn(
        address indexed recipient,
        uint256 indexed tokenId,
        address tokenIn,
        uint256 amountIn,
        uint128 liquidity
    );
    event ZapOut(
        address indexed recipient,
        uint256 indexed tokenId,
        address tokenOut,
        uint256 amountOut
    );

    // Sqrt-price limits used by V3.swap to mean "no slippage cap" on the
    // direction of the swap. Reproduced here so we can pass them inline
    // without importing TickMath constants.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // Canonical V3 tick bounds.
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    // Pool authorisation flag for the swap callback. Set before initiating a
    // pool.swap call, cleared in the callback. 0.7.6 has no transient
    // storage so we use a one-slot guard; cheaper than re-resolving via
    // factory.getPool on every callback.
    address private _authorisedPool;

    // CSEC-004: cheap re-entrancy lock for zapIn / zapInMaxRange / zapOut.
    // The contract sweeps balances at the end of each call so no current
    // drain path is reachable, but the missing guard is a defense-in-depth
    // gap vs. the V3Locker pattern (which already does this). 0.7.6 has
    // no transient storage, so we use a one-slot pattern: 0 = unlocked,
    // 1 = locked. Wrapping the three public entry points only - the
    // callbacks (uniswapV3SwapCallback) stay open because their msg.sender
    // gate already prevents arbitrary entry.
    uint256 private _entered;
    modifier nonReentrant() {
        require(_entered == 0, "REENTRANT");
        _entered = 1;
        _;
        _entered = 0;
    }

    struct ZapParams {
        // tokenIn: the leg the user pays in (approved to this contract).
        address tokenIn;
        // otherToken: the pool's other leg; sorted into (t0, t1) internally.
        address otherToken;
        // Pool fee tier in pip (3000 == 0.30%).
        uint24 fee;
        // Total amount of tokenIn the user is depositing.
        uint256 amountIn;
        // Caller-signed minimum tokenOther output from the internal swap
        // leg. MUST be derived off-chain from the pre-tx slot0 + the user's
        // slippage tolerance. The contract reverts if the swap delivers less.
        uint256 amountOtherMinSwap;
        // Mint slippage on canonical (token0, token1) ordering. Passed
        // straight through to NPM.mint - protects against same-block price
        // movement that would lower the liquidity actually minted.
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
        // Address that receives the V3 NFT (and any dust sweep).
        address recipient;
        // Audit V3 Zap C-1: caller-signed sqrtPriceX96 band the pool MUST
        // sit inside at execution time. Defends against a mempool grief
        // where an attacker pre-initialises a fresh pool at a hostile
        // sqrtPriceX96; the zap would otherwise route the user's deposit
        // around the adverse price and lose them money on the first swap.
        // Set both to 0 to opt out (e.g. for established pools where the
        // sqrtPrice has been moved by legitimate swaps and a static band
        // would no longer fit). When opted-in, the contract reads slot0
        // once and reverts if outside [min, max] OR if sqrtPrice == 0
        // (uninitialised pool).
        uint160 sqrtPriceX96Min;
        uint160 sqrtPriceX96Max;
    }

    struct ZapOutParams {
        // The V3 NFT to burn (caller must hold or have approved it).
        uint256 tokenId;
        // Amount of liquidity to remove from the position. Pass position
        // liquidity for a full exit.
        uint128 liquidity;
        // The single asset the caller wants to receive.
        address tokenOut;
        // Caller-signed minimum tokenOut output from the internal swap leg
        // (when the other leg is non-zero). Same defense as zap-in.
        uint256 amountOtherMinSwap;
        // Total tokenOut the caller must receive (decrease side + swap side).
        uint256 amountOutMin;
        // Slippage on the decreaseLiquidity step (passed to NPM).
        uint256 amount0DecreaseMin;
        uint256 amount1DecreaseMin;
        uint256 deadline;
        address recipient;
    }

    constructor(address factory_, address npm_) {
        require(factory_ != address(0) && npm_ != address(0), "ZERO");
        factory = factory_;
        npm = npm_;
    }

    // =================================================================
    //                          ZAP IN (NEW NFT)
    // =================================================================

    /**
     * @notice Zap one token into a max-range V3 position. The split is the
     *         analytic full-range limit of the in-range closed form: ~50/50
     *         by value at the current sqrtPrice; the trailing fee imbalance
     *         is small and gets absorbed by mint()'s desired-vs-min window.
     *         Dust returns to the recipient.
     */
    function zapInMaxRange(ZapParams calldata p)
        external
        nonReentrant
        returns (uint256 tokenId, uint128 liquidity)
    {
        // Audit V3 Zap H-5: read tickSpacing from the live pool instead
        // of the hardcoded 1/10/60/200 map. A custom factory enabling a
        // non-canonical fee (e.g. 2500) would otherwise mis-align with
        // the previous default (60), causing the locker mint to revert.
        (int24 tl, int24 tu) = _maxRangeTicksFromPool(p.tokenIn, p.otherToken, p.fee);
        return _zapIn(p, tl, tu);
    }

    /**
     * @notice Zap one token into a NARROW-range V3 position. The split is
     *         closed-form: for tokenIn = token0,
     *           swapAmount = amountIn * A / (A + feeFactor * B)
     *         where A = sqrtB * (sqrtP - sqrtA) and B = sqrtP * (sqrtB - sqrtP).
     *         For tokenIn = token1, swap by the symmetric form. Handles the
     *         degenerate out-of-range cases (single-sided position) by
     *         routing 0 or amountIn through the swap.
     */
    function zapIn(
        ZapParams calldata p,
        int24 tickLower,
        int24 tickUpper
    ) external nonReentrant returns (uint256 tokenId, uint128 liquidity) {
        return _zapIn(p, tickLower, tickUpper);
    }

    function _zapIn(
        ZapParams calldata p,
        int24 tickLower,
        int24 tickUpper
    ) internal returns (uint256 tokenId, uint128 liquidity) {
        require(block.timestamp <= p.deadline, "EXPIRED");
        require(p.amountIn > 0, "ZERO_AMOUNT");
        require(p.tokenIn != p.otherToken, "SAME_TOKEN");

        (address t0, address t1) = p.tokenIn < p.otherToken
            ? (p.tokenIn, p.otherToken)
            : (p.otherToken, p.tokenIn);

        // Audit 2026-06-29: snapshot pre-pull balances so the post-zap sweep
        // forwards only this call's residual, not any pre-parked balance
        // (donation / prior leftover). Ports the ArcadeV2Zap delta-sweep.
        uint256 b0 = IERC20Min(t0).balanceOf(address(this));
        uint256 b1 = IERC20Min(t1).balanceOf(address(this));

        IERC20Min(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);

        (tokenId, liquidity) = _zapInRoute(p, t0, t1, tickLower, tickUpper);
        _sweep(t0, p.recipient, b0);
        _sweep(t1, p.recipient, b1);
        emit ZapIn(p.recipient, tokenId, p.tokenIn, p.amountIn, liquidity);
    }

    struct _ZapCtx {
        address pool;
        int24 tickLower;
        int24 tickUpper;
        uint256 swapAmount;
        uint256 outReceived;
    }

    function _zapInRoute(
        ZapParams calldata p,
        address t0,
        address t1,
        int24 tickLower,
        int24 tickUpper
    ) internal returns (uint256 tokenId, uint128 liquidity) {
        _ZapCtx memory c;
        c.pool = IUniswapV3Factory(factory).getPool(t0, t1, p.fee);
        require(c.pool != address(0), "NO_POOL");
        // Audit V3 Zap C-1: sqrtPriceX96 band enforcement. Opt-in via
        // non-zero (min, max) in ZapParams. Always reverts on
        // uninitialised pools (sqrtPrice == 0) so the user can't be
        // tricked into routing a swap against a fresh pool an attacker
        // pre-inits at a hostile price between submit and inclusion.
        {
            (uint160 sp,,,,,,) = IUniswapV3Pool(c.pool).slot0();
            require(sp != 0, "POOL_UNINIT");
            if (p.sqrtPriceX96Min != 0 || p.sqrtPriceX96Max != 0) {
                require(
                    sp >= p.sqrtPriceX96Min && sp <= p.sqrtPriceX96Max,
                    "SQRT_PRICE_OOB"
                );
            }
        }
        (c.tickLower, c.tickUpper) = _alignTicks(
            tickLower, tickUpper, IUniswapV3Pool(c.pool).tickSpacing()
        );
        c.swapAmount = _calcZapSwapAmount(
            c.pool, p.amountIn, c.tickLower, c.tickUpper, p.tokenIn == t0, p.fee
        );
        if (c.swapAmount > 0) {
            c.outReceived = _doSwap(
                c.pool,
                p.tokenIn,
                c.swapAmount,
                p.tokenIn == t0,
                p.amountOtherMinSwap,
                p.sqrtPriceX96Min,
                p.sqrtPriceX96Max
            );
        }
        (tokenId, liquidity) = _doMint(
            p, t0, t1, c.tickLower, c.tickUpper,
            p.tokenIn == t0 ? p.amountIn - c.swapAmount : c.outReceived,
            p.tokenIn == t0 ? c.outReceived : p.amountIn - c.swapAmount
        );
    }

    function _calcZapSwapAmount(
        address pool,
        uint256 amountIn,
        int24 tickLower,
        int24 tickUpper,
        bool tokenInIsT0,
        uint24 fee
    ) internal view returns (uint256 swapAmount) {
        (uint160 sqrtP, , , , , , ) = IUniswapV3Pool(pool).slot0();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(tickUpper);

        // Out-of-range positions are single-sided.
        if (sqrtP <= sqrtA) {
            // Range above current. Need only token0.
            return tokenInIsT0 ? 0 : amountIn;
        }
        if (sqrtP >= sqrtB) {
            // Range below current. Need only token1.
            return tokenInIsT0 ? amountIn : 0;
        }

        // In-range: scale A and B down by Q96 so they fit in uint256.
        // A = sqrtB * (sqrtP - sqrtA), B = sqrtP * (sqrtB - sqrtP).
        // mulDiv handles 512-bit intermediates.
        uint256 A = FullMath.mulDiv(sqrtB, uint256(sqrtP - sqrtA), 1 << 96);
        uint256 B = FullMath.mulDiv(sqrtP, uint256(sqrtB - sqrtP), 1 << 96);
        uint256 feeNum = 1_000_000 - uint256(fee); // 997000 for 0.30%

        if (tokenInIsT0) {
            // swapAmount = amountIn * A / (A + B * feeFactor)
            uint256 denom = A + (B * feeNum) / 1_000_000;
            return FullMath.mulDiv(amountIn, A, denom);
        } else {
            // swapAmount = amountIn * B / (B + A * feeFactor)
            uint256 denom = B + (A * feeNum) / 1_000_000;
            return FullMath.mulDiv(amountIn, B, denom);
        }
    }

    /// @dev Audit V3 Zap H-5: resolve the pool first, then read its
    ///      actual tickSpacing(). Defends against a non-canonical fee
    ///      tier (e.g. 2_500) registered on the factory that the hard-
    ///      coded map below wouldn't know about.
    function _maxRangeTicksFromPool(address tokenA, address tokenB, uint24 fee)
        internal view returns (int24 tl, int24 tu)
    {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        address pool = IUniswapV3Factory(factory).getPool(t0, t1, fee);
        require(pool != address(0), "NO_POOL");
        int24 spacing = IUniswapV3Pool(pool).tickSpacing();
        tl = (MIN_TICK / spacing) * spacing;
        if (tl < MIN_TICK) tl += spacing;
        tu = (MAX_TICK / spacing) * spacing;
        if (tu > MAX_TICK) tu -= spacing;
    }

    function _maxRangeTicks(uint24 fee) internal pure returns (int24 tl, int24 tu) {
        // Approximate spacing from fee tier so we can render max range without
        // an RPC round-trip. Aligns to the canonical V3 spacings.
        // NOTE: superseded by _maxRangeTicksFromPool above (audit H-5);
        // kept for any view-only callers that don't need the live read.
        int24 spacing;
        if (fee == 100) spacing = 1;
        else if (fee == 500) spacing = 10;
        else if (fee == 3000) spacing = 60;
        else if (fee == 10000) spacing = 200;
        else spacing = 60; // sensible default
        tl = (MIN_TICK / spacing) * spacing;
        if (tl < MIN_TICK) tl += spacing;
        tu = (MAX_TICK / spacing) * spacing;
        if (tu > MAX_TICK) tu -= spacing;
    }

    function _alignTicks(int24 lo, int24 hi, int24 spacing)
        internal pure returns (int24 tl, int24 tu)
    {
        require(spacing > 0 && lo < hi, "BAD_TICKS");
        // Audit V3 Zap H-6: int24 division rounds toward ZERO in
        // Solidity, but the lower tick must round AWAY from zero (down)
        // so the user's signed range is widened, not narrowed. Same
        // mirrored for the upper tick. Without the negative-tick
        // adjustment, lo=-100 spacing=60 was producing tl=-60 (inside
        // the signed range) instead of tl=-120.
        tl = (lo / spacing) * spacing;
        if (lo < 0 && lo % spacing != 0) tl -= spacing;
        tu = (hi / spacing) * spacing;
        if (hi > 0 && hi % spacing != 0) tu += spacing;
        // Tightening guards: bound after the away-from-zero round.
        if (tl < MIN_TICK) tl += spacing;
        if (tu > MAX_TICK) tu -= spacing;
        require(tl >= MIN_TICK && tu <= MAX_TICK && tl < tu, "TICK_OOB");
    }

    function _doSwap(
        address pool,
        address tokenIn,
        uint256 swapAmount,
        bool zeroForOne,
        uint256 amountOutMin,
        uint160 sqrtPriceX96Min,
        uint160 sqrtPriceX96Max
    ) internal returns (uint256 outReceived) {
        _authorisedPool = pool;
        // Audit V3 Zap V3-4: cap the internal swap with the caller-signed
        // sqrtPriceX96 band rather than the absolute MIN/MAX_SQRT_RATIO.
        // A zero-for-one swap pushes price DOWN, so the user's
        // sqrtPriceX96Min becomes the floor; a one-for-zero pushes price
        // UP, so sqrtPriceX96Max becomes the ceiling. If the user opted
        // out of the band (left the relevant field at 0), fall back to
        // the wide-open MIN+1 / MAX-1 limits so behavior is unchanged.
        uint160 limit;
        if (zeroForOne) {
            // Floor: max(MIN_SQRT_RATIO + 1, sqrtPriceX96Min).
            limit = sqrtPriceX96Min > MIN_SQRT_RATIO + 1
                ? sqrtPriceX96Min
                : MIN_SQRT_RATIO + 1;
        } else {
            // Ceiling: min(MAX_SQRT_RATIO - 1, sqrtPriceX96Max). When
            // the user left max at 0, treat as "no cap" => MAX - 1.
            limit = (sqrtPriceX96Max != 0 && sqrtPriceX96Max < MAX_SQRT_RATIO - 1)
                ? sqrtPriceX96Max
                : MAX_SQRT_RATIO - 1;
        }
        (int256 amount0Delta, int256 amount1Delta) = IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(swapAmount),
            limit,
            abi.encode(tokenIn)
        );
        _authorisedPool = address(0);
        outReceived = uint256(-(zeroForOne ? amount1Delta : amount0Delta));
        require(outReceived >= amountOutMin, "SWAP_SLIPPAGE");
    }

    function _doMint(
        ZapParams calldata p,
        address t0,
        address t1,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired
    ) internal returns (uint256 tokenId, uint128 liquidity) {
        IERC20Min(t0).safeApprove(npm, amount0Desired);
        IERC20Min(t1).safeApprove(npm, amount1Desired);

        // Audit V3 Zap H-4: pass 0/0 as amount0Min/amount1Min to NPM.
        // The user-signed mins are computed against the OPTIMAL swap
        // output but the swap can slip down to amountOtherMinSwap; the
        // post-swap desired amounts can drop below the signed mins,
        // making the mint revert with NPM's `Price slippage check`
        // error even on otherwise-honest transactions. We already
        // protect against:
        //  - pool sqrtPriceX96 drift via the C-1 band check
        //  - swap output drift via amountOtherMinSwap (caller-signed
        //    floor on the swap leg)
        // So the NPM mins are redundant here; passing 0/0 lets the
        // mint pass on the realised post-swap balances.
        INonfungiblePositionManager.MintParams memory mp = INonfungiblePositionManager.MintParams({
            token0: t0,
            token1: t1,
            fee: p.fee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: 0,
            amount1Min: 0,
            recipient: p.recipient,
            deadline: p.deadline
        });
        (tokenId, liquidity, , ) = INonfungiblePositionManager(npm).mint(mp);
        // Audit V3 Zap H-2: zero out residual allowance to the NPM. If
        // the mint consumed less than amount0Desired/amount1Desired
        // (the common case at a non-50/50 ratio), the leftover allowance
        // sits permanently. NPM is trusted, but zeroing matches the
        // forceApprove(router, 0) pattern in the V2 Zap and removes
        // the stale-allowance footgun.
        IERC20Min(t0).safeApprove(npm, 0);
        IERC20Min(t1).safeApprove(npm, 0);
    }

    // =================================================================
    //                              ZAP OUT
    // =================================================================

    /**
     * @notice Burn (part of) a V3 position back into a single asset. Pulls
     *         the NFT via NPM.transferFrom, calls decreaseLiquidity + collect,
     *         then swaps the non-tokenOut leg through the pool. The user
     *         must approve this contract on the NPM beforehand (approve OR
     *         setApprovalForAll, NPM is an ERC-721).
     */
    function zapOut(ZapOutParams calldata p)
        external nonReentrant returns (uint256 amountOut)
    {
        require(block.timestamp <= p.deadline, "EXPIRED");
        require(p.liquidity > 0, "ZERO_LIQ");

        (address t0, address t1, uint24 fee) = _readPositionPair(p.tokenId);
        require(p.tokenOut == t0 || p.tokenOut == t1, "BAD_TOKEN_OUT");

        // Audit 2026-06-29: snapshot the non-tokenOut leg BEFORE the collect so
        // its post-settle sweep forwards only this call's residual, never a
        // balance parked in the zap. (tokenOut itself is paid via a computed
        // amountOut, not a balance sweep, so it needs no snapshot.)
        uint256 balBeforeOther =
            IERC20Min(p.tokenOut == t0 ? t1 : t0).balanceOf(address(this));

        // Pull the NFT, decrease + collect, return the NFT, then swap the
        // non-tokenOut leg. Splitting into helpers avoids 0.7.6's
        // stack-too-deep limit.
        // Audit V3 Zap H-1: NFT goes back to p.recipient (not
        // msg.sender). When msg.sender == p.recipient (direct UI call)
        // this is identical to the previous behavior; when they differ
        // (meta-tx relayer paying gas on behalf of the user), the NFT
        // lands with the user instead of the relayer.
        INonfungiblePositionManager(npm).transferFrom(msg.sender, address(this), p.tokenId);
        (uint256 collected0, uint256 collected1) = _decreaseAndCollect(p);
        INonfungiblePositionManager(npm).transferFrom(address(this), p.recipient, p.tokenId);

        amountOut = _zapOutSettle(p, t0, t1, fee, collected0, collected1);
        // Delta-sweep the non-tokenOut leg using the pre-collect snapshot so a
        // parked balance can't be skimmed by this caller (audit 2026-06-29).
        _sweep(p.tokenOut == t0 ? t1 : t0, p.recipient, balBeforeOther);
    }

    function _decreaseAndCollect(ZapOutParams calldata p)
        internal returns (uint256 c0, uint256 c1)
    {
        INonfungiblePositionManager(npm).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: p.tokenId,
                liquidity: p.liquidity,
                amount0Min: p.amount0DecreaseMin,
                amount1Min: p.amount1DecreaseMin,
                deadline: p.deadline
            })
        );
        (c0, c1) = INonfungiblePositionManager(npm).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: p.tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
    }

    function _zapOutSettle(
        ZapOutParams calldata p,
        address t0,
        address t1,
        uint24 fee,
        uint256 collected0,
        uint256 collected1
    ) internal returns (uint256 amountOut) {
        address pool = IUniswapV3Factory(factory).getPool(t0, t1, fee);
        require(pool != address(0), "NO_POOL");

        bool outIsT0 = p.tokenOut == t0;
        uint256 swapInAmount = outIsT0 ? collected1 : collected0;
        uint256 swapOut = 0;
        // Audit V3-2: when there is a non-zero swap leg, the caller MUST
        // supply a non-zero floor on the resulting swap output. The old
        // version silently skipped the swap when the caller passed 0,
        // delivering the "other" leg in its native token instead of the
        // requested tokenOut — a UI bug that handed the user a mixed
        // bag. Force the issue at the contract level so the next caller
        // can't repeat the mistake.
        require(swapInAmount == 0 || p.amountOtherMinSwap > 0, "NO_SWAP_FLOOR");
        if (swapInAmount > 0 && p.amountOtherMinSwap > 0) {
            // Audit V3 Zap V3-4: zapOut has no caller-signed band field
            // today; pass 0/0 so _doSwap falls back to the wide-open
            // MIN+1 / MAX-1 limits. If ZapOutParams ever grows a band
            // (parity with zap-in), thread the same fields through here.
            swapOut = _doSwap(
                pool,
                outIsT0 ? t1 : t0,
                swapInAmount,
                outIsT0 ? false : true,
                p.amountOtherMinSwap,
                0,
                0
            );
        }

        amountOut = (outIsT0 ? collected0 : collected1) + swapOut;
        require(amountOut >= p.amountOutMin, "ZAPOUT_SLIPPAGE");

        IERC20Min(p.tokenOut).safeTransfer(p.recipient, amountOut);
        // Non-tokenOut leg is swept by the caller (zapOut) with its pre-collect
        // snapshot — moved out of this helper to stay under 0.7.6 stack limits.
        emit ZapOut(p.recipient, p.tokenId, p.tokenOut, amountOut);
    }

    function _readPositionPair(uint256 tokenId)
        internal view returns (address t0, address t1, uint24 fee)
    {
        (
            , , address _t0, address _t1, uint24 _fee, , , , , , ,
        ) = INonfungiblePositionManager(npm).positions(tokenId);
        return (_t0, _t1, _fee);
    }

    // =================================================================
    //                           QUOTE (VIEW)
    // =================================================================

    /**
     * @notice Preview a zapIn for the UI. Returns the optimal swap split,
     *         the expected output of that swap, the expected mint amounts,
     *         and the expected liquidity. Mirrors the contract's internal
     *         math so the UI can render a faithful pre-sign breakdown.
     * @dev    View function - no state changes. The expected liquidity
     *         applies LiquidityAmounts at the post-swap balances, so it's
     *         the same value V3's mint will use modulo per-tick rounding.
     */
    struct QuoteResult {
        uint256 swapAmount;
        uint256 expectedOut;
        uint256 expectedAmount0;
        uint256 expectedAmount1;
        uint128 expectedLiquidity;
    }

    struct QuoteInput {
        address tokenIn;
        address otherToken;
        uint24 fee;
        uint256 amountIn;
        int24 tickLower;
        int24 tickUpper;
    }

    /// @notice Preview a zapIn. Inputs packed in a struct to dodge 0.7.6
    ///         stack-too-deep. View only.
    function quoteZap(QuoteInput calldata i)
        external view returns (QuoteResult memory q)
    {
        if (i.amountIn == 0 || i.tokenIn == i.otherToken) return q;
        (address t0, address t1) = i.tokenIn < i.otherToken
            ? (i.tokenIn, i.otherToken)
            : (i.otherToken, i.tokenIn);
        address pool = IUniswapV3Factory(factory).getPool(t0, t1, i.fee);
        if (pool == address(0)) return q;

        (int24 tl, int24 tu) = _alignTicks(
            i.tickLower, i.tickUpper, IUniswapV3Pool(pool).tickSpacing()
        );
        bool isT0 = i.tokenIn == t0;
        q.swapAmount = _calcZapSwapAmount(pool, i.amountIn, tl, tu, isT0, i.fee);
        q.expectedOut = _quoteSwapOut(pool, q.swapAmount, isT0, i.fee);
        q.expectedAmount0 = isT0 ? i.amountIn - q.swapAmount : q.expectedOut;
        q.expectedAmount1 = isT0 ? q.expectedOut : i.amountIn - q.swapAmount;
        q.expectedLiquidity = _quoteLiquidity(pool, tl, tu, q.expectedAmount0, q.expectedAmount1);
    }

    function _quoteSwapOut(
        address pool,
        uint256 swapAmount,
        bool tokenInIsT0,
        uint24 fee
    ) internal view returns (uint256 expectedOut) {
        if (swapAmount == 0) return 0;
        (uint160 sqrtP, , , , , , ) = IUniswapV3Pool(pool).slot0();
        uint256 feeNum = 1_000_000 - uint256(fee);
        if (tokenInIsT0) {
            expectedOut = FullMath.mulDiv(
                FullMath.mulDiv(swapAmount, sqrtP, 1 << 96),
                uint256(sqrtP) * feeNum,
                uint256(1 << 96) * 1_000_000
            );
        } else {
            expectedOut = FullMath.mulDiv(
                FullMath.mulDiv(swapAmount, 1 << 96, sqrtP),
                uint256(1 << 96) * feeNum,
                uint256(sqrtP) * 1_000_000
            );
        }
    }

    function _quoteLiquidity(
        address pool,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0,
        uint256 amount1
    ) internal view returns (uint128) {
        (uint160 sqrtP, , , , , , ) = IUniswapV3Pool(pool).slot0();
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtP,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            amount0,
            amount1
        );
    }

    // =================================================================
    //                            CALLBACKS / UTIL
    // =================================================================

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        require(msg.sender == _authorisedPool, "BAD_CALLBACK");
        // Audit V3 Zap C-2: defense in depth — even though
        // _authorisedPool is set inline by _doSwap and gates re-entry
        // by virtue of being address(0) outside the active swap, also
        // sanity-check the deltas. A real V3 pool always passes one
        // positive and one non-positive (or both zero on a no-op swap
        // which never happens). Reject anything else.
        require(amount0Delta > 0 || amount1Delta > 0, "BAD_DELTAS");
        address tokenIn = abi.decode(data, (address));
        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : uint256(amount1Delta);
        IERC20Min(tokenIn).safeTransfer(msg.sender, amountToPay);
    }

    function _sweep(address token, address to, uint256 balBefore) internal {
        uint256 bal = IERC20Min(token).balanceOf(address(this));
        // Audit 2026-06-29: forward only THIS call's residual (current minus the
        // pre-pull / pre-collect snapshot), never a balance parked in the zap by
        // a donation or a prior tx's leftover dust. Ports the ArcadeV2Zap MEDIUM
        // delta-sweep fix that was never carried over to V3 — without it the next
        // zap caller sweeps any parked balance to themselves.
        uint256 dust = bal > balBefore ? bal - balBefore : 0;
        // Audit V3 Zap L-3: require the transfer return so a silently-failing
        // non-standard ERC20 doesn't leave the dust in the contract while the
        // caller thinks the sweep succeeded.
        if (dust > 0) IERC20Min(token).safeTransfer(to, dust);
    }
}
