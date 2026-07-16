// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IArcadeV2Router} from "../dex/interfaces/IArcadeV2Router.sol";
import {IArcadeLaunchpad} from "../launchpad/interfaces/IArcadeLaunchpad.sol";

/**
 * @title ArcadeMigratedRouter
 * @notice Post-migration trading wrappers for graduated launchpad tokens,
 *         EXTRACTED VERBATIM from ArcadeLaunchpad to shed >823 bytes and bring
 *         the launchpad back under the EIP-170 24,576-byte limit (`forge test`
 *         never caught the overflow because the test EVM ignores EIP-170; only
 *         `forge build --sizes` or a real deploy does).
 *
 *         This is deliberately an EXTRACTION, not a removal. The pair-level fee
 *         redesign made these wrappers charge nothing extra (the graduated pair
 *         charges the 0.30% in its own K), so they LOOK deletable -- but
 *         swapMigratedRoute carries the `usdcMidMin` mid-leg sandwich guard
 *         (audit 2026-06-11 #10), and all four carry the CLANKER_V3 rejection
 *         (a CLANKER_V3 token has no V2 pair, so routing it through V2 would hit
 *         an attacker-creatable pair with false slippage protection). Deleting
 *         them and letting the frontend route token<->token through the plain
 *         V2 router would silently re-open that sandwich, and no test would
 *         catch it. Keeping the exact logic here, on-chain, means NO security
 *         property depends on getting a frontend reroute right.
 *
 *         The only change from the launchpad originals: `tokens[x]` (internal
 *         storage) becomes `launchpad.getTokenState(x)` (the public view), so
 *         this contract needs no privileged access -- it is pure periphery over
 *         the V2 router, readable by anyone.
 */
contract ArcadeMigratedRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable v2Router;
    IArcadeLaunchpad public immutable launchpad;

    error Expired();
    error UnknownToken();
    error NotMigrated();
    error InvalidRoute();
    error ZeroAmount();
    error NoRouter();
    error Slippage();
    error MidSlippage();
    error ZeroAddress();

    constructor(IERC20 usdc_, address v2Router_, IArcadeLaunchpad launchpad_) {
        if (address(usdc_) == address(0) || v2Router_ == address(0) || address(launchpad_) == address(0)) {
            revert ZeroAddress();
        }
        USDC = usdc_;
        v2Router = v2Router_;
        launchpad = launchpad_;
    }

    function _path2(address a, address b) internal pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = a;
        path[1] = b;
    }

    /// @notice Buy a migrated token by routing through the V2 router. A thin
    /// wrapper: the graduated pair charges the whole 0.30% fee in its own K, so
    /// this adds nothing. Rejects CLANKER_V3 (no V2 pair).
    function buyMigrated(address tokenAddr, uint256 usdcIn, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        IArcadeLaunchpad.TokenState memory s = launchpad.getTokenState(tokenAddr);
        if (s.token == address(0)) revert UnknownToken();
        if (!s.migrated) revert NotMigrated();
        // CLANKER_V3 tokens have NO V2 pair (they trade on the locked V3 pool):
        // routing them through V2 would hit an attacker-creatable pair with
        // false slippage protection. Force them onto the V3 router instead.
        if (s.mode == IArcadeLaunchpad.LaunchMode.CLANKER_V3) revert InvalidRoute();
        if (usdcIn == 0) revert ZeroAmount();

        USDC.safeTransferFrom(msg.sender, address(this), usdcIn);
        USDC.forceApprove(v2Router, usdcIn);
        uint256[] memory amounts = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            usdcIn, minTokensOut, _path2(address(USDC), tokenAddr), msg.sender, deadline
        );
        tokensOut = amounts[1];
    }

    /// @notice Sell a migrated token via V2. Measures the received USDC delta
    /// (this contract is a custody intermediary) rather than trusting the
    /// router's returned amount. The fee is INPUT-side in the pair's K; `to`
    /// receives exactly the stock library amount, so there is no output skim.
    function sellMigrated(address tokenAddr, uint256 tokensIn, uint256 minUsdcOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (block.timestamp > deadline) revert Expired();
        IArcadeLaunchpad.TokenState memory s = launchpad.getTokenState(tokenAddr);
        if (s.token == address(0)) revert UnknownToken();
        if (!s.migrated) revert NotMigrated();
        if (s.mode == IArcadeLaunchpad.LaunchMode.CLANKER_V3) revert InvalidRoute();
        if (tokensIn == 0) revert ZeroAmount();

        IERC20(tokenAddr).safeTransferFrom(msg.sender, address(this), tokensIn);
        IERC20(tokenAddr).forceApprove(v2Router, tokensIn);
        uint256 balBefore = USDC.balanceOf(address(this));
        IArcadeV2Router(v2Router).swapExactTokensForTokens(
            tokensIn, 0, _path2(tokenAddr, address(USDC)), address(this), deadline
        );
        usdcOut = USDC.balanceOf(address(this)) - balBefore;
        if (usdcOut < minUsdcOut) revert Slippage();
        USDC.safeTransfer(msg.sender, usdcOut);
    }

    /// @dev Shared validation + classification for the token<->token migrated
    /// route (swapMigratedRoute + its quote). Returns `ok=false` for an
    /// unroutable pair: same token, either side USDC, either side CLANKER_V3, or
    /// neither side a migrated launch.
    function _migratedPair(address tokenIn, address tokenOut)
        internal
        view
        returns (bool inMig, bool outMig, bool ok)
    {
        if (tokenIn == tokenOut || tokenIn == address(USDC) || tokenOut == address(USDC)) {
            return (false, false, false);
        }
        IArcadeLaunchpad.TokenState memory sIn = launchpad.getTokenState(tokenIn);
        IArcadeLaunchpad.TokenState memory sOut = launchpad.getTokenState(tokenOut);
        if (
            sIn.mode == IArcadeLaunchpad.LaunchMode.CLANKER_V3
                || sOut.mode == IArcadeLaunchpad.LaunchMode.CLANKER_V3
        ) {
            return (false, false, false);
        }
        inMig = sIn.token != address(0) && sIn.migrated;
        outMig = sOut.token != address(0) && sOut.migrated;
        ok = inMig || outMig;
    }

    /// @notice Swap `tokensIn` of `tokenIn` for `tokenOut` via the USDC pivot.
    ///         Enforces `usdcMidMin` on the intermediate USDC -- the mid-leg
    ///         sandwich guard (audit 2026-06-11 #10). The stock V2 router checks
    ///         only the FINAL amountOutMin, so this floor is the ONLY thing that
    ///         stops a sandwicher moving just the tokenIn/USDC pool from driving
    ///         usdcMid low and scraping past minTokensOut. Never route this pair
    ///         through the plain V2 router without an equivalent floor.
    function swapMigratedRoute(
        address tokenIn,
        address tokenOut,
        uint256 tokensIn,
        uint256 minTokensOut,
        uint256 usdcMidMin,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        (,, bool ok) = _migratedPair(tokenIn, tokenOut);
        if (!ok) revert InvalidRoute();

        // --- Leg 1: tokenIn -> USDC ---
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), tokensIn);
        IERC20(tokenIn).forceApprove(v2Router, tokensIn);
        uint256 balBeforeMid = USDC.balanceOf(address(this));
        IArcadeV2Router(v2Router).swapExactTokensForTokens(
            tokensIn, 0, _path2(tokenIn, address(USDC)), address(this), deadline
        );
        uint256 usdcMid = USDC.balanceOf(address(this)) - balBeforeMid;
        // THE mid-leg guard. Sandwiching leg 1 drives usdcMid low; without this
        // the leg-2 chain could still scrape past minTokensOut on a thin pair.
        if (usdcMid < usdcMidMin) revert MidSlippage();

        // --- Leg 2: USDC -> tokenOut, delivered to the user ---
        USDC.forceApprove(v2Router, usdcMid);
        uint256[] memory leg2 = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            usdcMid, minTokensOut, _path2(address(USDC), tokenOut), msg.sender, deadline
        );
        tokensOut = leg2[1];
    }

    /// @notice View quote for `swapMigratedRoute`. Returns `(tokensOut, usdcMid)`
    ///         so the caller can derive the `usdcMidMin` floor (typically 97% of
    ///         usdcMid). A caller that passes 0 as the floor silently re-opens
    ///         the mid-leg sandwich, so the frontend MUST use this value.
    function quoteSwapMigratedRoute(address tokenIn, address tokenOut, uint256 tokensIn)
        external
        view
        returns (uint256 tokensOut, uint256 usdcMid)
    {
        if (tokensIn == 0) return (0, 0);
        (,, bool ok) = _migratedPair(tokenIn, tokenOut);
        if (!ok) return (0, 0);
        uint256[] memory leg1 = IArcadeV2Router(v2Router).getAmountsOut(tokensIn, _path2(tokenIn, address(USDC)));
        usdcMid = leg1[1];
        uint256[] memory leg2 = IArcadeV2Router(v2Router).getAmountsOut(usdcMid, _path2(address(USDC), tokenOut));
        tokensOut = leg2[1];
    }
}
