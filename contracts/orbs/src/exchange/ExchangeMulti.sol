// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

import "../IExchange.sol";

/**
 * ExchangeMulti — one trusted, keeper-only IExchange adapter that can settle an
 * Orbs TWAP fill on ANY approve-to-router DEX (Arcade V2/V3, XyloNet, future
 * forks) without deploying a new adapter per venue.
 *
 * WHY THIS SHAPE (security, read before touching):
 * TWAP.performFill enforces `dstAmountOut >= o.dstExpectedOutNext()`, where
 * `dstExpectedOutNext = max(bid.dstAmount, dstMinAmountNext())` and
 * `bid.dstAmount` is whatever IExchange.getAmountOut() returns for the winning
 * bid. If a maker's order left `ask.exchange == address(0)`, the TAKER picks the
 * exchange contract, so an attacker points it at their OWN exchange that returns
 * an inflated getAmountOut(), wins the fresh-order auction uncontested (bidDelay
 * 30s << keeper cadence), then at fill delivers only the floor and keeps the
 * surplus. That is why orders MUST pin `ask.exchange` to a trusted contract.
 *
 * This contract IS that trusted pin. Orders set `ask.exchange = ExchangeMulti`.
 * The multi-venue flexibility lives one level down and is fully gated:
 *   - Only an allow-listed TAKER (our keeper) may quote or fill — `allowedTaker`.
 *   - The ROUTER the fill executes against must be owner-allow-listed —
 *     `allowedRouter`. The keeper chooses the router per fill (so it can route to
 *     the best venue) but only from the vetted set; it can never point the
 *     approval + call at an arbitrary contract.
 * With both gates, the taker is trusted infra and the router is a vetted DEX, so
 * the exchange-swap surface is exactly ExchangeV2's — only generalized across a
 * known set of routers. Adding a DEX = `setRouterAllowed(newRouter, true)`, no
 * redeploy and no new order type.
 *
 * bidData layout: abi.encode(uint256 amountOut, address router, bytes swapData)
 *   amountOut — the committed output the keeper quoted (used by getAmountOut).
 *   router    — which allow-listed router to execute against this fill.
 *   swapData  — the calldata for that router (recipient MUST be this adapter, so
 *               the output lands here and `swap` can forward it to TWAP).
 */
contract ExchangeMulti is IExchange, Ownable2Step {
    using SafeERC20 for IERC20;

    mapping(address => bool) public allowedTaker;
    mapping(address => bool) public allowedRouter;

    error InsufficientOutputAmount(uint256 actual, uint256 minimum);
    error TakerNotAllowed(address taker);
    error RouterNotAllowed(address router);
    error ZeroAddress();
    error RenounceDisabled();

    event TakerSet(address indexed taker, bool allowed);
    event RouterSet(address indexed router, bool allowed);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    constructor(address[] memory _takers, address[] memory _routers) {
        for (uint256 i = 0; i < _takers.length; i++) {
            if (_takers[i] == address(0)) revert ZeroAddress();
            allowedTaker[_takers[i]] = true;
            emit TakerSet(_takers[i], true);
        }
        for (uint256 i = 0; i < _routers.length; i++) {
            if (_routers[i] == address(0)) revert ZeroAddress();
            allowedRouter[_routers[i]] = true;
            emit RouterSet(_routers[i], true);
        }
    }

    // --- governance (owner = deployer, Ownable2Step-transfer to the Safe post-deploy) ---

    function setTakerAllowed(address taker, bool allowed) external onlyOwner {
        if (taker == address(0)) revert ZeroAddress();
        allowedTaker[taker] = allowed;
        emit TakerSet(taker, allowed);
    }

    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouter[router] = allowed;
        emit RouterSet(router, allowed);
    }

    /**
     * Recover tokens stranded in the adapter. ExchangeMulti routes to many
     * routers, some of which (V3 exactOutput, aggregators) refund unspent input
     * to msg.sender = this adapter; that residue would otherwise be locked. The
     * adapter holds nothing between (atomic) fills, so this only ever moves
     * refund dust / donations, never in-flight maker funds. onlyOwner (the Safe).
     */
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Rescued(address(token), to, amount);
    }

    /**
     * Disabled: renouncing would permanently freeze the router/taker allowlists,
     * bricking the "add a DEX with one call" purpose and leaving any compromised
     * router/keeper unrevokable. Ownership must be TRANSFERRED (to the Safe), not
     * dropped.
     */
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // --- IExchange ---

    function getAmountOut(address, address, uint256, bytes calldata, bytes calldata bidData, address taker)
        public
        view
        returns (uint256 dstAmountOut)
    {
        if (!allowedTaker[taker]) revert TakerNotAllowed(taker);
        (dstAmountOut,,) = decode(bidData);
    }

    function swap(
        address _srcToken,
        address _dstToken,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata,
        bytes calldata bidData,
        address taker
    ) public {
        if (!allowedTaker[taker]) revert TakerNotAllowed(taker);

        (, address router, bytes memory swapData) = decode(bidData);
        if (!allowedRouter[router]) revert RouterNotAllowed(router);

        IERC20 src = IERC20(_srcToken);
        IERC20 dst = IERC20(_dstToken);

        src.safeTransferFrom(msg.sender, address(this), amountIn);
        amountIn = src.balanceOf(address(this)); // support FoT tokens

        src.forceApprove(router, amountIn);
        Address.functionCall(router, swapData);
        // Zero any allowance the router did not consume, so no residual approval
        // to a (still vetted, but) previously-used router lingers between fills.
        src.forceApprove(router, 0);

        uint256 balance = dst.balanceOf(address(this));
        if (balance < minOut) revert InsufficientOutputAmount(balance, minOut);

        dst.safeTransfer(msg.sender, balance);
    }

    function decode(bytes calldata data)
        private
        pure
        returns (uint256 amountOut, address router, bytes memory swapData)
    {
        return abi.decode(data, (uint256, address, bytes));
    }
}
