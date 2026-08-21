// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ArcadeSwapFeeRouter
 * @notice A thin fee-taking hop for swaps of EXTERNAL launchpad / memecoin tokens
 *         (radardex, sharc, canonical Uniswap, ...) routed through the Arcade UI.
 *         It skims a protocol fee on the INPUT, forwards the rest to an
 *         owner-vetted venue router with the caller's own swap calldata, enforces
 *         the trader's minOut, and returns the whole output to the trader.
 *
 *         WHY input-side: a fee taken from the OUTPUT would silently eat into the
 *         amountOutMin the trader signed for (fund-loss). Taking it from the input
 *         means the quote/minOut is computed on the NET amount and the on-chain
 *         minOut check still fully protects the trader.
 *
 *         WHAT it does NOT do: it never decides which tokens are "taxable". The
 *         Arcade frontend routes ONLY external-token swaps through this contract;
 *         base-asset swaps (USDC/ETH/stables) and Arcade's own launchpad tokens
 *         (already fee'd at the pool/hook level) route directly to the venue
 *         router and never touch this hop. So this contract simply charges
 *         `feeBps` on everything that passes through it.
 *
 *         SECURITY MODEL (mirrors the audited ExchangeMulti):
 *          - ROUTER ALLOWLIST. `swap` only calls an owner-allow-listed router with
 *            arbitrary calldata. The allow-listed routers are vetted stateless
 *            DEX routers that can only pull from THIS contract's transient
 *            approval, so arbitrary calldata cannot reach a third party's funds.
 *          - minOut ENFORCED on-chain, so a sandwich/mis-quote can only revert,
 *            never under-deliver.
 *          - CUSTODY-FREE. Every swap pulls, fees, forwards and sweeps in one
 *            call; nothing is held between swaps. `rescue` only recovers dust.
 *          - Ownable2Step (Safe), renounce disabled so the allowlist / fee can
 *            never be frozen, feeBps hard-capped so a bad value can't brick swaps.
 */
contract ArcadeSwapFeeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Address for address;

    /// @notice Protocol fee in bps taken from the input of every swap routed here.
    ///         Default 50 = 0.50%. Owner-tunable up to MAX_FEE_BPS.
    uint16 public feeBps;

    /// @notice Hard ceiling on feeBps (2%) so a mis-set value can never brick a
    ///         swap or gouge a trader beyond a sane bound.
    uint16 public constant MAX_FEE_BPS = 200;

    /// @notice Where the skimmed fee goes (the treasury Safe).
    address public treasury;

    /// @notice Owner-vetted venue routers this contract may call.
    mapping(address => bool) public allowedRouter;

    event Swapped(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 fee,
        uint256 amountOut,
        address router
    );
    event FeeBpsSet(uint16 feeBps);
    event TreasurySet(address indexed treasury);
    event RouterSet(address indexed router, bool allowed);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error RouterNotAllowed(address router);
    error InsufficientOutput(uint256 got, uint256 minOut);
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error SameToken();
    error FeeExceedsMax(uint16 feeBps, uint16 maxFeeBps);
    error RenounceDisabled();

    /// @param owner_       Ownable2Step owner (treasury Safe).
    /// @param treasury_    fee recipient.
    /// @param feeBps_      initial fee (<= MAX_FEE_BPS).
    /// @param routers      initial allow-listed venue routers.
    constructor(address owner_, address treasury_, uint16 feeBps_, address[] memory routers) Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        treasury = treasury_;
        feeBps = feeBps_;
        emit TreasurySet(treasury_);
        emit FeeBpsSet(feeBps_);
        for (uint256 i = 0; i < routers.length; i++) {
            if (routers[i] == address(0)) revert ZeroAddress();
            allowedRouter[routers[i]] = true;
            emit RouterSet(routers[i], true);
        }
    }

    // --------------------------------------------------------------------
    // Swap
    // --------------------------------------------------------------------

    /// @notice Fee-skim then forward a swap to an allow-listed venue router.
    /// @param tokenIn   input token (trader must have approved THIS contract).
    /// @param tokenOut  output token (must differ from tokenIn).
    /// @param amountIn  input amount to pull from the trader.
    /// @param minOut    minimum tokenOut the trader must receive (computed by the
    ///                  UI on the NET-of-fee input; enforced here).
    /// @param maxFeeBps the highest feeBps the trader accepts. Pins the fee so a
    ///                  concurrent owner setFeeBps can't raise the fee in-flight;
    ///                  pass the quoted feeBps (optionally + a small tolerance).
    /// @param router    an allow-listed venue router.
    /// @param swapData  the router calldata (recipient MUST be this contract, so
    ///                  the output lands here to be swept to the trader). The UI
    ///                  builds it against the NET input (amountIn - fee).
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint16 maxFeeBps,
        address router,
        bytes calldata swapData
    ) external nonReentrant returns (uint256 amountOut) {
        if (!allowedRouter[router]) revert RouterNotAllowed(router);
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert ZeroAmount();

        uint16 fbps = feeBps;
        if (fbps > maxFeeBps) revert FeeExceedsMax(fbps, maxFeeBps);

        IERC20 tin = IERC20(tokenIn);
        IERC20 tout = IERC20(tokenOut);

        // Measure the INPUT by delta (balanceAfter - balanceBefore) so any stray
        // pre-existing balance can't inflate the fee/net, and a fee-on-transfer
        // input is handled on what actually arrived.
        uint256 inBefore = tin.balanceOf(address(this));
        tin.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = tin.balanceOf(address(this)) - inBefore;

        // Skim the protocol fee from the INPUT and send it to the treasury; the
        // rest is what gets swapped.
        uint256 fee = (received * fbps) / 10_000;
        uint256 net = received - fee;
        if (fee > 0) tin.safeTransfer(treasury, fee);

        // Measure the OUTPUT by delta too, so this swap only ever pays the trader
        // the output IT produced -- never a stranded balance from a prior swap
        // (which stays recoverable via rescue, not front-runnable here).
        uint256 outBefore = tout.balanceOf(address(this));

        // Approve exactly the net to the router, execute the trader's calldata,
        // then zero any residual approval. A revert here bubbles and unwinds the
        // whole tx (fee included), so no partial state can persist.
        tin.forceApprove(router, net);
        router.functionCall(swapData);
        tin.forceApprove(router, 0);

        // Sweep only the delta this swap produced to the trader, enforcing the
        // trader's floor first.
        amountOut = tout.balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        tout.safeTransfer(msg.sender, amountOut);

        emit Swapped(msg.sender, tokenIn, tokenOut, received, fee, amountOut, router);
    }

    // --------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        emit FeeBpsSet(newFeeBps);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouter[router] = allowed;
        emit RouterSet(router, allowed);
    }

    /// @notice Recover tokens mistakenly left here. The swap path is custody-free
    ///         so this only ever moves refund dust / donations.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Rescued(address(token), to, amount);
    }

    /// @notice Disabled so the router allowlist / fee can never be frozen.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
