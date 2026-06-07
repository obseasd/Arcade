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
    function _routeOne(address tokenIn, address tokenOut, uint256 amountIn, uint256 deadline) internal returns (uint256) {
        // 0) V4 takes priority: any leg touching a V4 launch routes through
        // the V4 swap router (potentially via USDC for cross-version legs).
        bool inIsV4 = _isV4LaunchToken(tokenIn);
        bool outIsV4 = _isV4LaunchToken(tokenOut);
        if (inIsV4 || outIsV4) {
            return _swapV4Path(tokenIn, tokenOut, amountIn, inIsV4, outIsV4, deadline);
        }

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
            uint256 out = launchpad.swapMigratedRoute(tokenIn, tokenOut, amountIn, 0, deadline);
            // M-08 / L-05: reset launchpad allowance after the call.
            IERC20(tokenIn).forceApprove(address(launchpad), 0);
            return out;
        }

        return _swapV2(tokenIn, tokenOut, amountIn, /*viaUsdc=*/ true, deadline);
    }

    /// @dev Dispatch for legs touching a V4 launch. Cases:
    ///        (V4, USDC)  -> single V4 swap
    ///        (USDC, V4)  -> single V4 swap
    ///        (V4, V4)    -> V4 swap to USDC, then USDC -> V4
    ///        (V4, other) -> V4 swap to USDC, then USDC -> other via V2/V3
    ///        (other, V4) -> other -> USDC via V2/V3, then USDC -> V4
    function _swapV4Path(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool inIsV4,
        bool outIsV4,
        uint256 deadline
    ) internal returns (uint256) {
        // V4 <-> USDC: one V4 hop.
        if (tokenIn == address(USDC) || tokenOut == address(USDC)) {
            return _swapV4Single(tokenIn, tokenOut, amountIn);
        }

        // V4 <-> V4: pivot through USDC, both legs on V4.
        if (inIsV4 && outIsV4) {
            uint256 usdcOut = _swapV4Single(tokenIn, address(USDC), amountIn);
            return _swapV4Single(address(USDC), tokenOut, usdcOut);
        }

        // Mixed: V4 leg + V2/V3 leg, pivoting through USDC. We recurse into
        // `_routeOne` for the non-V4 leg so it gets the existing V2/V3 path
        // selection (direct, migrated, multi-hop, etc).
        if (inIsV4) {
            uint256 usdcOut = _swapV4Single(tokenIn, address(USDC), amountIn);
            return _routeOne(address(USDC), tokenOut, usdcOut, deadline);
        }
        // outIsV4
        uint256 usdcMid = _routeOne(tokenIn, address(USDC), amountIn, deadline);
        return _swapV4Single(address(USDC), tokenOut, usdcMid);
    }

    /// @dev Execute a single V4 swap between `tokenIn` and `tokenOut`, one
    ///      of which is USDC and the other a registered V4 launch. Looks up
    ///      the PoolKey from the launchpad and derives `zeroForOne` from the
    ///      key's currency sort.
    function _swapV4Single(address tokenIn, address tokenOut, uint256 amountIn)
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
            0, // aggregator-internal slippage = 0; final slippage at swapToSingle
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
    function _swapV2(address tokenIn, address tokenOut, uint256 amountIn, bool viaUsdc, uint256 deadline)
        internal
        returns (uint256 amountOut)
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
        amountOut = amounts[path.length - 1];
        // M-08 / L-05: reset allowance after the swap.
        IERC20(tokenIn).forceApprove(address(v2Router), 0);
    }

    /// @dev Route a leg through the V3 router. Single hop if the other side is
    /// USDC (USDC-paired Clanker V3 pool), two-hop pivoting through USDC
    /// otherwise (eg ClankerA -> USDC -> ClankerB).
    function _swapV3(address tokenIn, address tokenOut, uint256 amountIn, uint256 deadline)
        internal
        returns (uint256 amountOut)
    {
        if (address(v3Router) == address(0)) revert ZeroAddress();
        IERC20(tokenIn).forceApprove(address(v3Router), amountIn);
        if (tokenIn == address(USDC) || tokenOut == address(USDC)) {
            amountOut = v3Router.exactInputSingle(tokenIn, tokenOut, V3_FEE, address(this), amountIn, 0, deadline);
        } else {
            // MEV-001 fix: pass usdcMidMin = 0 here (mirrors the existing
            // amountOutMinimum = 0 on this call site; MultiSwap relies on
            // its OWN minOut at the outer Input level for slippage protection).
            // The interface previously only had 7 args; calling the deployed
            // 8-arg router via a 7-arg interface selector ALWAYS reverted, so
            // V3 two-hop swaps via MultiSwap were silently broken in prod.
            amountOut = v3Router.exactInputThroughUsdc(tokenIn, tokenOut, V3_FEE, address(this), amountIn, 0, 0, deadline);
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

    function _quoteOne(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        // M-07: V3 AND V4 routes need a separate quoter call. Without this
        // short-circuit, a V4 leg would fall through to the V2 path which
        // would either revert (no V2 pair for the V4 token) or return 0 -
        // indistinguishable from "no liquidity" in the UI. Return 0 with
        // the documented contract: UI must merge in V3/V4 quoter results.
        if (_isV3LaunchToken(tokenIn) || _isV3LaunchToken(tokenOut)) return 0;
        if (_isV4LaunchToken(tokenIn) || _isV4LaunchToken(tokenOut)) return 0;

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
