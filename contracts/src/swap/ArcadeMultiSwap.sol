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

/// @dev V4 PoolKey on the wire. Upstream v4-core types this as
///      `(Currency, Currency, uint24, int24, IHooks)` where `Currency is
///      address`. Our local declaration uses raw addresses for both ends
///      (ABI-compatible because the encoding is identical), so MultiSwap
///      doesn't need to compile against v4-core's 0.8.26 types from inside
///      this 0.8.24 profile.
struct V4PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @dev Minimal slice of `ArcadeV4Launchpad` we need to look up a launch's
///      PoolKey. The returned struct's shape MUST match the upstream
///      ArcadeV4Launchpad.Launch layout exactly so ABI decoding succeeds.
interface IArcadeV4LaunchpadMin {
    struct Launch {
        address token;
        address creator;
        V4PoolKey poolKey;
        uint16 snipeStartBps;
        uint32 snipeDecaySeconds;
        uint64 launchedAt;
        uint16 creatorBps;
    }
    function getLaunch(address token) external view returns (Launch memory);
    /// @notice The single hook address baked into every V4 launchpad pool.
    ///         MultiSwap reads this to whitelist the only hook it's allowed
    ///         to forward swaps through (H-06).
    function HOOK() external view returns (address);
}

/// @dev Minimal slice of `ArcadeV4SwapRouter` we need to route a V4 leg.
interface IArcadeV4SwapRouterMin {
    function exactInputSingle(
        V4PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
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
 *           3. Either side is a curve-migrated launchpad token (with a V2
 *              pair): route through the launchpad's buyMigrated / sellMigrated /
 *              swapMigratedRoute wrappers.
 *           4. USDC on either side OR direct A<->B pool exists: direct V2.
 *           5. Otherwise: V2 multi-hop via USDC.
 *
 *         HISTORICAL NOTE, kept because the comments below still lean on it:
 *         step 3 used to be load-bearing for FEES -- migrated wrappers skimmed a
 *         0.30% royalty that a direct-V2 swap (step 4) bypassed, so 3 had to be
 *         checked first (HIGH-1) or a USDC-side migrated leg dodged the fee. On
 *         the pair-level-fee branch the graduated pair charges the fee in its
 *         own K, on EVERY route, so nothing can bypass it and 3-before-4 is no
 *         longer a fee constraint. The ordering is retained (the wrappers still
 *         carry the CLANKER_V3 guard and the correct pool selection); the
 *         "royalty" language in the per-branch comments is that dead rationale,
 *         not a second charge.
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
    /// @notice ArcadeV4SwapRouter — required to route V4 launch tokens. May
    ///         be address(0) on deployments without the V4 stack; in that
    ///         case `_isV4LaunchToken` always returns false and the V4
    ///         dispatch is dead code.
    IArcadeV4SwapRouterMin public immutable v4Router;
    /// @notice ArcadeV4Launchpad — used to look up a token's PoolKey when
    ///         we route a V4 leg. May be address(0) - same semantics as
    ///         v4Router (V4 dispatch is gated on BOTH being set).
    IArcadeV4LaunchpadMin public immutable v4Launchpad;
    /// @notice V3 fee tier used for all Clanker V3 pools (1%). Matches the
    /// launchpad constant.
    uint24 public constant V3_FEE = 10_000;

    /// @dev Cap to keep gas predictable and prevent malicious "long-list" calls.
    uint256 public constant MAX_INPUTS = 8;

    struct Input {
        address token;
        uint256 amount;
        /// @notice H-07: caller-supplied floor on the amount of `tokenOut`
        ///         THIS leg must produce, enforced as the router's real
        ///         `amountOutMinimum`. Prior to H-07 every leg routed with a
        ///         0 / 1-wei floor, so a sandwicher could fully drain one thin
        ///         leg as long as the basket-wide `minTotalOut` still held.
        ///         Pass 0 to opt this leg out (legacy behaviour); the basket
        ///         `minTotalOut` still applies. The frontend / agent lib
        ///         always derives a real value from the per-leg quote.
        uint256 minOut;
        /// @notice H-07: caller-supplied floor on the USDC produced by the
        ///         intermediate hop when THIS leg routes tokenIn -> USDC ->
        ///         tokenOut (V2-via-USDC multi-hop and the migrated route).
        ///         Replaces the execution-time inline quote, which a
        ///         sandwicher controls via the tokenIn/USDC reserves. Pass 0
        ///         to keep the old 1-wei behaviour; legs that never pivot
        ///         through USDC ignore it.
        uint256 usdcMidMin;
    }

    error EmptyInputs();
    error TooManyInputs();
    error DeadlinePassed();
    error InsufficientOutput();
    error ZeroAmount();
    error ZeroAddress();
    error UnknownHook();
    error PoolNotInitialized();

    event MultiSwap(
        address indexed sender,
        address indexed tokenOut,
        uint256 inputsCount,
        uint256 totalOut
    );

    /// @param v3Router_     ArcadeV3SwapRouter — `address(0)` to disable the
    ///                      V3 leg entirely (Clanker V3 launches won't be
    ///                      routable).
    /// @param v4Router_     ArcadeV4SwapRouter — `address(0)` to disable the
    ///                      V4 leg entirely (V4 launches won't be routable
    ///                      through this aggregator; the frontend nudges
    ///                      users to the per-token V4 swap panel in that case).
    /// @param v4Launchpad_  ArcadeV4Launchpad — same opt-in semantics as
    ///                      `v4Router_`. Both must be set together; if either
    ///                      is zero, V4 dispatch is skipped.
    constructor(
        IERC20 usdc_,
        IArcadeV2Factory v2Factory_,
        IArcadeV2Router v2Router_,
        IArcadeLaunchpad launchpad_,
        IArcadeV3Router v3Router_,
        IArcadeV4SwapRouterMin v4Router_,
        IArcadeV4LaunchpadMin v4Launchpad_
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
        v4Router = v4Router_; // may be address(0) - see _isV4LaunchToken
        v4Launchpad = v4Launchpad_;
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
            uint256 got = _routeOne(inp.token, tokenOut, inp.amount, inp.minOut, inp.usdcMidMin, deadline);
            // H-07: enforce this leg's own floor. This is the crux of the
            // fix: previously a single thin leg could be fully sandwiched
            // (its amountOutMinimum was 0) as long as the OTHER legs kept
            // the basket total above minTotalOut. Now each leg must clear
            // its own quoted floor.
            if (got < inp.minOut) revert InsufficientOutput();
            totalOut += got;
        }

        if (totalOut < minTotalOut) revert InsufficientOutput();

        IERC20(tokenOut).safeTransfer(msg.sender, totalOut);

        emit MultiSwap(msg.sender, tokenOut, inputs.length, totalOut);
    }

    /// @dev Returns true iff `token` is a Clanker V3 launch — must route via the
    /// V3 router, not the V2 path. Uses the launchpad's authoritative mode, NOT
    /// the presence/absence of a V2 pair: an attacker can create a rogue V2 pair
    /// for a V3 token, and the old getPair==0 heuristic would then mis-route the
    /// V3 token through that poisoned pair with false slippage protection.
    function _isV3LaunchToken(address token) internal view returns (bool) {
        return launchpad.getTokenState(token).mode == IArcadeLaunchpad.LaunchMode.CLANKER_V3;
    }

    /// @dev Returns true iff `token` is registered in the V4 launchpad and
    ///      therefore trades only on a V4 pool. Cheap: a single SLOAD on the
    ///      launchpad's `launches` mapping. Short-circuits to false when the
    ///      V4 stack isn't wired into this aggregator.
    ///      L-09: also requires the launch's PoolKey to be initialized
    ///      (currency0 != 0). A registered-but-not-yet-initialized launch
    ///      would otherwise route to a zeroed PoolKey and revert opaquely.
    function _isV4LaunchToken(address token) internal view returns (bool) {
        if (address(v4Launchpad) == address(0) || address(v4Router) == address(0)) return false;
        if (token == address(USDC)) return false; // USDC never the launch token
        // getLaunch returns a zeroed Launch struct (token == address(0)) when
        // the address isn't registered.
        IArcadeV4LaunchpadMin.Launch memory l = v4Launchpad.getLaunch(token);
        if (l.token != token) return false;
        return l.poolKey.currency0 != address(0);
    }

    /// @dev Picks the best route for a single (tokenIn -> tokenOut) leg and
    /// executes it. Output is sent to `address(this)` so the caller can
    /// accumulate before forwarding.
    /// @param minOut      H-07: the router-level `amountOutMinimum` for this
    ///                    leg's FINAL hop. Threaded into every leaf router call
    ///                    (V2, V3, V4, migrated) so a sandwiched leg reverts at
    ///                    the router instead of scraping past on a 0 floor.
    /// @param usdcMidMin  H-07: caller floor for the intermediate USDC hop
    ///                    (V2-via-USDC and migrated routes). Replaces the old
    ///                    inline execution-time quote (sandwicher-controlled).
    function _routeOne(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 usdcMidMin,
        uint256 deadline
    ) internal returns (uint256) {
        // 0) V4 takes priority: any leg touching a V4 launch routes through
        // the V4 swap router (potentially via USDC for cross-version legs).
        bool inIsV4 = _isV4LaunchToken(tokenIn);
        bool outIsV4 = _isV4LaunchToken(tokenOut);
        if (inIsV4 || outIsV4) {
            return _swapV4Path(tokenIn, tokenOut, amountIn, inIsV4, outIsV4, minOut, usdcMidMin, deadline);
        }

        // 1) Clanker V3 launches have no V2 pair — route via the V3 router.
        bool inIsV3 = _isV3LaunchToken(tokenIn);
        bool outIsV3 = _isV3LaunchToken(tokenOut);
        if (inIsV3 || outIsV3) {
            return _swapV3(tokenIn, tokenOut, amountIn, minOut, usdcMidMin, deadline);
        }

        // 2) HIGH-1 (2026-07-02 fee audit): migrated launch tokens MUST be
        // routed through the launchpad BEFORE the plain-V2 branch below. A
        // curve-migrated token trades on a real USDC V2 pair, so the old
        // ordering let every USDC-side migrated leg (the common buy/sell
        // direction) short-circuit into a royalty-free V2 swap, permanently
        // bypassing the post-migration royalty (0.30% = 0.20% platform +
        // 0.10% creator). Any migrated leg now pays the royalty.
        bool inMigrated = launchpad.isMigrated(tokenIn);
        bool outMigrated = launchpad.isMigrated(tokenOut);
        if (inMigrated || outMigrated) {
            return _swapMigrated(tokenIn, tokenOut, amountIn, minOut, usdcMidMin, deadline);
        }

        // 3) Direct V2 path (non-migrated only): USDC pivot or an explicit
        // A<->B pool exists.
        bool oneSideUsdc = tokenIn == address(USDC) || tokenOut == address(USDC);
        if (oneSideUsdc || v2Factory.getPair(tokenIn, tokenOut) != address(0)) {
            return _swapV2(tokenIn, tokenOut, amountIn, /*viaUsdc=*/ false, minOut, usdcMidMin, deadline);
        }

        // 4) Multi-hop via USDC for a non-migrated pair with no direct pool.
        return _swapV2(tokenIn, tokenOut, amountIn, /*viaUsdc=*/ true, minOut, usdcMidMin, deadline);
    }

    /// @dev Routes a leg where at least one side is a curve-migrated launchpad
    ///      token through the launchpad so the post-migration royalty is
    ///      charged on every direction. HIGH-1 fix (2026-07-02): the previous
    ///      code only reached the multi-hop `swapMigratedRoute`, which reverts
    ///      when either side is USDC, so USDC-side migrated buys/sells fell
    ///      through to a royalty-free V2 swap. We now dispatch the single-hop
    ///      USDC cases to buyMigrated / sellMigrated and keep swapMigratedRoute
    ///      for the token<->token pivot. Clanker V3 launches are handled earlier
    ///      in _routeOne, so any migrated token reaching here has a V2 pair.
    /// @param minOut     H-07 final-hop floor (tokens for a buy, USDC for a
    ///                   sell, tokenOut for the pivot); enforced by the
    ///                   launchpad on every branch.
    /// @param usdcMidMin H-07 floor for the intermediate USDC hop; only the
    ///                   token<->token pivot uses it (the single-hop USDC cases
    ///                   have no distinct mid-hop).
    function _swapMigrated(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 usdcMidMin,
        uint256 deadline
    ) internal returns (uint256) {
        // Case A: USDC -> migrated token (buy). Royalty skimmed from usdcIn;
        // the launchpad delivers the tokens to this contract (msg.sender).
        if (tokenIn == address(USDC)) {
            USDC.forceApprove(address(launchpad), amountIn);
            uint256 outA = launchpad.buyMigrated(tokenOut, amountIn, minOut, deadline);
            USDC.forceApprove(address(launchpad), 0);
            return outA;
        }

        // Case B: migrated token -> USDC (sell). Royalty skimmed from the USDC
        // output; the launchpad delivers the net USDC to this contract.
        if (tokenOut == address(USDC)) {
            IERC20(tokenIn).forceApprove(address(launchpad), amountIn);
            uint256 outB = launchpad.sellMigrated(tokenIn, amountIn, minOut, deadline);
            IERC20(tokenIn).forceApprove(address(launchpad), 0);
            return outB;
        }

        // Case C: migrated token <-> non-USDC token via the USDC pivot, royalty
        // on each migrated leg.
        //
        // Audit 2026-06-11 v2 G9-2: the balance-delta sanity check is `>=`, not
        // `==`. A 1-wei USDC donation to this contract (anyone can
        // `USDC.transfer(multiswap, 1)`) would brick a `==` check; the
        // realistic threat -- USDC drained OUT -- is still caught because
        // `balAfter >= balBefore` only tolerates incoming transfers. Combined
        // with `nonReentrant` this is sufficient.
        //
        // H-07: `usdcMidMin` is the caller-supplied floor for the intermediate
        // USDC hop (was quoted inline at execution-time reserves, which a
        // sandwicher controls); `minOut` is threaded as the launchpad's
        // `minTokensOut` so a sandwiched leg reverts rather than scraping past.
        IERC20(tokenIn).forceApprove(address(launchpad), amountIn);
        uint256 balBefore = USDC.balanceOf(address(this));
        uint256 outC = launchpad.swapMigratedRoute(tokenIn, tokenOut, amountIn, minOut, usdcMidMin, deadline);
        uint256 balAfter = USDC.balanceOf(address(this));
        require(balAfter >= balBefore, "BAL_DRIFT");
        // M-08 / L-05: reset launchpad allowance after the call.
        IERC20(tokenIn).forceApprove(address(launchpad), 0);
        return outC;
    }

    /// @dev Dispatch for legs touching a V4 launch. Cases:
    ///        (V4, USDC)  -> single V4 swap
    ///        (USDC, V4)  -> single V4 swap
    ///        (V4, V4)    -> V4 swap to USDC, then USDC -> V4
    ///        (V4, other) -> V4 swap to USDC, then USDC -> other via V2/V3
    ///        (other, V4) -> other -> USDC via V2/V3, then USDC -> V4
    /// @param minOut      H-07: final-hop floor for the leg (the V4 hop that
    ///                    lands on `tokenOut`, or the recursed V2/V3 leg).
    /// @param usdcMidMin  H-07: floor for the USDC produced by the FIRST hop
    ///                    when this leg pivots through USDC (V4->USDC->x or
    ///                    x->USDC->V4). It applies to the intermediate USDC,
    ///                    NOT the final tokenOut.
    function _swapV4Path(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool inIsV4,
        bool outIsV4,
        uint256 minOut,
        uint256 usdcMidMin,
        uint256 deadline
    ) internal returns (uint256) {
        // V4 <-> USDC: one V4 hop. minOut floors the final output directly.
        if (tokenIn == address(USDC) || tokenOut == address(USDC)) {
            return _swapV4Single(tokenIn, tokenOut, amountIn, minOut);
        }

        // V4 <-> V4: pivot through USDC, both legs on V4. usdcMidMin floors
        // the mid USDC, minOut floors the final V4 output.
        if (inIsV4 && outIsV4) {
            uint256 usdcOut = _swapV4Single(tokenIn, address(USDC), amountIn, usdcMidMin);
            return _swapV4Single(address(USDC), tokenOut, usdcOut, minOut);
        }

        // Mixed: V4 leg + V2/V3 leg, pivoting through USDC. We recurse into
        // `_routeOne` for the non-V4 leg so it gets the existing V2/V3 path
        // selection (direct, migrated, multi-hop, etc). The recursed leg
        // carries `minOut` for its final hop; its own internal usdcMid (if it
        // multi-hops again) is left unfloored (0) since the caller only
        // supplied one usdcMidMin, which we spend on the V4 mid hop here.
        if (inIsV4) {
            uint256 usdcOut = _swapV4Single(tokenIn, address(USDC), amountIn, usdcMidMin);
            return _routeOne(address(USDC), tokenOut, usdcOut, minOut, 0, deadline);
        }
        // outIsV4: first the V2/V3 leg tokenIn->USDC (floored by usdcMidMin),
        // then the final V4 hop USDC->tokenOut (floored by minOut).
        uint256 usdcMid = _routeOne(tokenIn, address(USDC), amountIn, usdcMidMin, 0, deadline);
        return _swapV4Single(address(USDC), tokenOut, usdcMid, minOut);
    }

    /// @dev Execute a single V4 swap between `tokenIn` and `tokenOut`, one
    ///      of which is USDC and the other a registered V4 launch. Looks up
    ///      the PoolKey from the launchpad and derives `zeroForOne` from the
    ///      key's currency sort.
    function _swapV4Single(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
        internal
        returns (uint256 amountOut)
    {
        address v4Token = tokenIn == address(USDC) ? tokenOut : tokenIn;
        IArcadeV4LaunchpadMin.Launch memory l = v4Launchpad.getLaunch(v4Token);
        // L-09: refuse a swap against an uninitialized PoolKey. _isV4LaunchToken
        // already filters most cases but this is the last-line guard.
        if (l.poolKey.currency0 == address(0)) revert PoolNotInitialized();
        // H-06: only forward the swap if the PoolKey's hook matches the V4
        // launchpad's pinned HOOK. Without this, a future launchpad upgrade
        // that lets creators choose hooks would let arbitrary code (with
        // BEFORE_SWAP_RETURNS_DELTA permission) run on user funds. We read
        // the expected hook from the launchpad on every call so a hook
        // migration doesn't require redeploying MultiSwap.
        if (l.poolKey.hooks != v4Launchpad.HOOK()) revert UnknownHook();
        // zeroForOne == true iff tokenIn is currency0 of the pool.
        bool zeroForOne = tokenIn == l.poolKey.currency0;
        IERC20(tokenIn).forceApprove(address(v4Router), amountIn);
        amountOut = v4Router.exactInputSingle(
            l.poolKey,
            zeroForOne,
            amountIn,
            minAmountOut, // H-07: caller's per-leg floor (was 0)
            address(this),
            0  // sqrtPriceLimitX96 = unlimited within tick range
        );
        // M-08 / L-05: reset allowance to zero so a partial pull doesn't
        // leave a stale approval on the router across calls. Anti-sniper
        // hook can reduce the input the pool actually consumes via
        // BeforeSwapDelta, so amountIn-consumed >= 0 is the typical case.
        IERC20(tokenIn).forceApprove(address(v4Router), 0);
    }

    /// @dev Helper for the two V2 paths (direct or via USDC).
    /// @param minOut      H-07: `amountOutMinimum` for the FINAL hop (was 0).
    /// @param usdcMidMin  H-07: caller floor for the intermediate USDC hop on
    ///                    the via-USDC path (was a decorative 1-wei). Ignored
    ///                    on the direct (non-viaUsdc) path.
    function _swapV2(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool viaUsdc,
        uint256 minOut,
        uint256 usdcMidMin,
        uint256 deadline
    )
        internal
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).forceApprove(address(v2Router), amountIn);
        if (!viaUsdc) {
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            uint256[] memory amounts = v2Router.swapExactTokensForTokens(
                amountIn, minOut, path, address(this), deadline
            );
            amountOut = amounts[1];
            IERC20(tokenIn).forceApprove(address(v2Router), 0);
            return amountOut;
        }

        // MEV-007 / H-07: a single 3-hop swapExactTokensForTokens(amountIn, 0,
        // [in, USDC, out], ...) only enforces a slippage bound on the FINAL
        // leg. A sandwicher who controls only the tokenIn/USDC pair can drive
        // usdcMid arbitrarily low, then the USDC/out leg's smoothing can still
        // scrape past the outer minTotalOut. Split into two single hops with
        // the CALLER's `usdcMidMin` on the first leg (was a decorative 1-wei
        // that a sandwicher could always clear) and the CALLER's `minOut` on
        // the final leg.
        address[] memory path1 = new address[](2);
        path1[0] = tokenIn;
        path1[1] = address(USDC);
        // Enforce at least 1 wei out even when the caller passes usdcMidMin==0,
        // so a total mid-leg collapse still reverts (preserves the old floor's
        // grief-resistance for callers that opt out of a real mid floor).
        uint256 midFloor = usdcMidMin == 0 ? 1 : usdcMidMin;
        uint256[] memory leg1 = v2Router.swapExactTokensForTokens(
            amountIn, midFloor, path1, address(this), deadline
        );
        uint256 usdcMid = leg1[1];
        IERC20(tokenIn).forceApprove(address(v2Router), 0);

        USDC.forceApprove(address(v2Router), usdcMid);
        address[] memory path2 = new address[](2);
        path2[0] = address(USDC);
        path2[1] = tokenOut;
        uint256[] memory leg2 = v2Router.swapExactTokensForTokens(
            usdcMid, minOut, path2, address(this), deadline
        );
        amountOut = leg2[1];
        USDC.forceApprove(address(v2Router), 0);
    }

    /// @dev Route a leg through the V3 router. Single hop if the other side is
    /// USDC (USDC-paired Clanker V3 pool), two-hop pivoting through USDC
    /// otherwise (eg ClankerA -> USDC -> ClankerB).
    /// @param minOut      H-07: `amountOutMinimum` for the final hop (was 0).
    /// @param usdcMidMin  H-07: caller floor for the intermediate USDC hop on
    ///                    the two-hop (non-USDC pair) path (was 0). Ignored on
    ///                    the single-hop (USDC-paired) path.
    function _swapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 usdcMidMin,
        uint256 deadline
    )
        internal
        returns (uint256 amountOut)
    {
        if (address(v3Router) == address(0)) revert ZeroAddress();
        IERC20(tokenIn).forceApprove(address(v3Router), amountIn);
        if (tokenIn == address(USDC) || tokenOut == address(USDC)) {
            amountOut = v3Router.exactInputSingle(tokenIn, tokenOut, V3_FEE, address(this), amountIn, minOut, deadline);
        } else {
            // MEV-001 / H-07: thread the caller's `usdcMidMin` into the mid
            // USDC hop and `minOut` into the final hop (both were 0). The
            // interface previously only had 7 args; calling the deployed
            // 8-arg router via a 7-arg interface selector ALWAYS reverted, so
            // V3 two-hop swaps via MultiSwap were silently broken in prod.
            amountOut = v3Router.exactInputThroughUsdc(tokenIn, tokenOut, V3_FEE, address(this), amountIn, minOut, usdcMidMin, deadline);
        }
        IERC20(tokenIn).forceApprove(address(v3Router), 0);
    }

    // ====================== Views ======================

    /**
     * @notice View quote that mirrors `swapToSingle`. Returns the expected
     * total output and a parallel array of per-input outputs so the UI can
     * highlight which legs contribute most. Pure-view: does not change state.
     *
     * Quoting V3 or V4 routes requires a live `eth_call` to the respective
     * quoter which we can't do from a pure view here. The UI should call the
     * V3 / V4 quoter directly for those legs; this view returns 0 for any
     * leg that touches a V3 or V4 launch token (M-07).
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

    // QUOTE_MIGRATED_ROYALTY_BPS is DELETED. It mirrored
    // ArcadeLaunchpad.MIGRATED_ROYALTY_BPS so quotes matched the wrapper
    // royalty on buyMigrated / sellMigrated -- both of which this redesign
    // removed. The pair now charges the fee inside its own K, and
    // getAmountsOut already prices the 997/1000 the pair enforces, so a quote
    // needs no extra deduction. A dead constant instructing the reader to
    // "stay in sync with MIGRATED_ROYALTY_BPS" is worse than none: it names a
    // constant that no longer exists and implies a deduction that would now
    // DOUBLE-count the fee.
    uint256 private constant QUOTE_FEE_DENOM = 10_000;

    /// @dev Two-hop V2 getAmountsOut, returning 0 on any router revert.
    function _v2Out2(address a, address b, uint256 amt) internal view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = a;
        path[1] = b;
        try v2Router.getAmountsOut(amt, path) returns (uint256[] memory amounts) {
            return amounts[1];
        } catch {
            return 0;
        }
    }

    function _quoteOne(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        // M-07: V3 AND V4 routes need a separate quoter call. Without this
        // short-circuit, a V4 leg would fall through to the V2 path which
        // would either revert (no V2 pair for the V4 token) or return 0 -
        // indistinguishable from "no liquidity" in the UI. Return 0 with
        // the documented contract: UI must merge in V3/V4 quoter results.
        if (_isV3LaunchToken(tokenIn) || _isV3LaunchToken(tokenOut)) return 0;
        if (_isV4LaunchToken(tokenIn) || _isV4LaunchToken(tokenOut)) return 0;

        // HIGH-1: mirror _routeOne's ordering. Migrated legs are royalty-charged
        // BEFORE the plain-V2 branch, so the quote must deduct the royalty too;
        // quoting them as a bare V2 swap would over-state the output by 0.30%.
        bool inMigrated = launchpad.isMigrated(tokenIn);
        bool outMigrated = launchpad.isMigrated(tokenOut);
        if (inMigrated || outMigrated) {
            // Case A: USDC -> migrated (buyMigrated) - royalty off the input.
            if (tokenIn == address(USDC)) {
                // The pair charges the graduated fee in-pool now, and
                // getAmountsOut already prices it, so no extra deduction.
                return _v2Out2(tokenIn, tokenOut, amountIn);
            }
            // Case B: migrated -> USDC (sellMigrated) - royalty off the output.
            if (tokenOut == address(USDC)) {
                // Pair-level fee, already priced by getAmountsOut.
                return _v2Out2(tokenIn, tokenOut, amountIn);
            }
            // Case C: token <-> token pivot - launchpad's royalty-aware quote.
            try launchpad.quoteSwapMigratedRoute(tokenIn, tokenOut, amountIn) returns (
                uint256 tokensOut,
                uint256 /*royalty*/
            ) {
                return tokensOut;
            } catch {
                return 0;
            }
        }

        // Non-migrated direct V2: USDC pivot or an explicit A<->B pool.
        bool oneSideUsdc = tokenIn == address(USDC) || tokenOut == address(USDC);
        if (oneSideUsdc || v2Factory.getPair(tokenIn, tokenOut) != address(0)) {
            return _v2Out2(tokenIn, tokenOut, amountIn);
        }

        // Non-migrated token<->token with no direct pool: V2 multi-hop via USDC.
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
