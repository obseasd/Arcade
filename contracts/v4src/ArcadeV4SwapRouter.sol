// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

/**
 * @title ArcadeV4SwapRouter
 * @notice Thin router that lets EOAs swap through V4 pools. V4 forbids direct
 *         `poolManager.swap` calls outside of an `unlock` callback; this
 *         contract is the canonical caller for our launchpad's pools.
 *
 *         Flow per swap:
 *           1. Caller approves this contract to spend their input currency.
 *           2. Caller invokes `exactInputSingle` or `exactOutputSingle`.
 *           3. Router calls `poolManager.unlock(encoded args)`. The manager
 *              calls back into `unlockCallback`, where we:
 *                a. `poolManager.swap` to generate a BalanceDelta.
 *                b. `sync` + transfer input from caller + `settle` for the
 *                   currency we owe the pool.
 *                c. `take` the output currency to the recipient.
 *              All currency deltas zero at callback return → manager accepts.
 *           4. Router enforces slippage on the realised input/output and
 *              returns the amount the user actually received / spent.
 *
 *         No fees, no path-finding, no Permit2 — single-pool single-hop
 *         only. Multi-hop or aggregator behavior layers on top.
 *
 *         License: MIT (our code). Depends on v4-core under BUSL-1.1 — same
 *         non-production-use scope as the rest of `v4src/`.
 */
contract ArcadeV4SwapRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable POOL_MANAGER;

    error NotPoolManager();
    error SlippageExceeded(uint256 actual, uint256 limit);
    error ZeroAmount();
    error SwapFailed();

    event SwapExecuted(
        address indexed payer,
        address indexed recipient,
        Currency indexed inputCurrency,
        Currency outputCurrency,
        uint256 amountIn,
        uint256 amountOut,
        bool zeroForOne
    );

    /// @dev Encoded payload pushed through `poolManager.unlock` and decoded
    ///      in `unlockCallback`.
    struct SwapCallbackData {
        address payer;
        address recipient;
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified; // negative = exact-in, positive = exact-out
        uint160 sqrtPriceLimitX96;
    }

    constructor(IPoolManager poolManager_) {
        POOL_MANAGER = poolManager_;
    }

    // -----------------------------------------------------------------
    // Public entry-points
    // -----------------------------------------------------------------

    /**
     * @notice Swap an exact amount of input currency for as much output as
     *         possible, reverting if the output falls below `minAmountOut`.
     * @param key             PoolKey identifying the V4 pool.
     * @param zeroForOne      True if swapping currency0 -> currency1.
     * @param amountIn        Exact input amount the caller sends.
     * @param minAmountOut    Slippage floor on the output the recipient gets.
     * @param recipient       Destination of the output currency.
     * @param sqrtPriceLimitX96 Price limit (0 = unlimited within tick range).
     * @return amountOut      Realised output the recipient received.
     */
    function exactInputSingle(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint160 sqrtPriceLimitX96
    ) external nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();

        Currency inputCurrency = zeroForOne ? key.currency0 : key.currency1;
        Currency outputCurrency = zeroForOne ? key.currency1 : key.currency0;

        bytes memory result = POOL_MANAGER.unlock(
            abi.encode(
                SwapCallbackData({
                    payer: msg.sender,
                    recipient: recipient,
                    key: key,
                    zeroForOne: zeroForOne,
                    // V4 convention: NEGATIVE = exact-input.
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: sqrtPriceLimitX96
                })
            )
        );
        amountOut = abi.decode(result, (uint256));
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        emit SwapExecuted(msg.sender, recipient, inputCurrency, outputCurrency, amountIn, amountOut, zeroForOne);
    }

    /**
     * @notice Swap as much input as needed to receive an exact output amount,
     *         reverting if the input required exceeds `maxAmountIn`.
     */
    function exactOutputSingle(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountOut,
        uint256 maxAmountIn,
        address recipient,
        uint160 sqrtPriceLimitX96
    ) external nonReentrant returns (uint256 amountIn) {
        if (amountOut == 0) revert ZeroAmount();

        Currency inputCurrency = zeroForOne ? key.currency0 : key.currency1;
        Currency outputCurrency = zeroForOne ? key.currency1 : key.currency0;

        bytes memory result = POOL_MANAGER.unlock(
            abi.encode(
                SwapCallbackData({
                    payer: msg.sender,
                    recipient: recipient,
                    key: key,
                    zeroForOne: zeroForOne,
                    // V4 convention: POSITIVE = exact-output.
                    amountSpecified: int256(amountOut),
                    sqrtPriceLimitX96: sqrtPriceLimitX96
                })
            )
        );
        amountIn = abi.decode(result, (uint256));
        if (amountIn > maxAmountIn) revert SlippageExceeded(amountIn, maxAmountIn);

        emit SwapExecuted(msg.sender, recipient, inputCurrency, outputCurrency, amountIn, amountOut, zeroForOne);
    }

    // -----------------------------------------------------------------
    // IUnlockCallback
    // -----------------------------------------------------------------

    /// @inheritdoc IUnlockCallback
    /// @dev Only callable by the PoolManager mid-unlock. Performs the swap,
    ///      settles the input debt by pulling from the payer, and takes the
    ///      output credit to the recipient.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        SwapCallbackData memory cb = abi.decode(data, (SwapCallbackData));

        // Run the swap. BalanceDelta is from the SWAP'S perspective:
        //   negative on the side the pool RECEIVED from us (we owe it)
        //   positive on the side the pool PAID to us (we're owed)
        BalanceDelta delta = POOL_MANAGER.swap(
            cb.key,
            SwapParams({
                zeroForOne: cb.zeroForOne,
                amountSpecified: cb.amountSpecified,
                sqrtPriceLimitX96: cb.sqrtPriceLimitX96
            }),
            ""
        );

        // Split into input / output amounts based on swap direction.
        (Currency inputCurrency, Currency outputCurrency, int128 inputDelta, int128 outputDelta) =
            cb.zeroForOne
                ? (cb.key.currency0, cb.key.currency1, delta.amount0(), delta.amount1())
                : (cb.key.currency1, cb.key.currency0, delta.amount1(), delta.amount0());

        // We expect to OWE input (negative) and be OWED output (positive).
        // Any other shape is a malformed swap result.
        if (inputDelta >= 0 || outputDelta <= 0) revert SwapFailed();

        uint256 amountIn = uint256(uint128(-inputDelta));
        uint256 amountOut = uint256(uint128(outputDelta));

        // Settle the input debt: sync the currency, pull from payer, settle.
        POOL_MANAGER.sync(inputCurrency);
        IERC20(Currency.unwrap(inputCurrency)).safeTransferFrom(cb.payer, address(POOL_MANAGER), amountIn);
        POOL_MANAGER.settle();

        // Take the output credit to the recipient.
        POOL_MANAGER.take(outputCurrency, cb.recipient, amountOut);

        // For exact-input swaps the caller knows amountIn; for exact-output
        // they know amountOut. Return the "other" one so they can enforce
        // slippage.
        return abi.encode(cb.amountSpecified < 0 ? amountOut : amountIn);
    }
}
