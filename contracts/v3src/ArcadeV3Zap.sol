// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title ArcadeV3Zap
 * @notice Single-asset zap into a Uniswap V3 position. Mirrors Hyperswap's
 *         max-range constraint: the user provides one token, half is swapped
 *         to the other side via the pool itself, and both legs mint a single
 *         full-range NFT. The full-range constraint matters because the
 *         deposit ratio for a max-range position is well-conditioned around
 *         the current price (the half/half split is near-optimal). Narrow
 *         ranges need a closed-form split that depends on the chosen ticks;
 *         queued as a follow-up.
 *
 *         Solidity 0.7.6 to inherit the canonical V3 callback interfaces and
 *         INonfungiblePositionManager types without re-vendoring. Approvals:
 *         user approves THIS Zap for `tokenIn`. The Zap then approves the NPM
 *         on demand for the resulting balances. Dust returns to the caller.
 */
contract ArcadeV3Zap is IUniswapV3SwapCallback {
    address public immutable factory;
    address public immutable npm;

    // Sqrt-price limits used by V3.swap to mean "no slippage cap" on the
    // direction of the swap. Reproduced here so we can pass them inline
    // without importing TickMath.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // Canonical V3 tick bounds. Rounded down/up to the pool's tickSpacing
    // at mint time so the on-chain checkTicks guard passes.
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    // Pool authorisation flag for the swap callback. Set before initiating a
    // pool.swap call, cleared in the callback. 0.7.6 has no transient
    // storage so we use a one-slot guard; cheaper than re-resolving via
    // factory.getPool on every callback.
    address private _authorisedPool;

    // ZapParams. tokenIn: what the user pays in (approved to this contract).
    // otherToken: the pool's other leg; sorted into (t0, t1) internally.
    // fee: pool fee tier in pip (3000 == 0.30%). amountIn: total deposit.
    // amount{0,1}Min: mint slippage minimums on canonical (token0, token1)
    // ordering, 0 to accept any. deadline: unix-epoch cutoff. recipient:
    // who receives the V3 NFT.
    struct ZapParams {
        address tokenIn;
        address otherToken;
        uint24 fee;
        uint256 amountIn;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
        address recipient;
    }

    constructor(address factory_, address npm_) {
        require(factory_ != address(0) && npm_ != address(0), "ZERO");
        factory = factory_;
        npm = npm_;
    }

    /**
     * @notice Zap one token into a max-range V3 position. Splits `amountIn`
     *         50/50 by value at the current pool price (~optimal for a full-
     *         range position; ignores the ~30 bp swap fee, which surfaces as
     *         a small balance imbalance that mint() consumes inside its
     *         desired/min window). Returns the minted NFT's tokenId.
     */
    function zapInMaxRange(ZapParams calldata p)
        external
        returns (uint256 tokenId, uint128 liquidity)
    {
        require(block.timestamp <= p.deadline, "EXPIRED");
        require(p.amountIn > 0, "ZERO_AMOUNT");
        require(p.tokenIn != p.otherToken, "SAME_TOKEN");

        // Pull the deposit from the user upfront. Approvals stay on
        // `tokenIn` only; the swap leg pays via balance, the mint via
        // explicit NPM allowance.
        require(
            IERC20Min(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn),
            "PULL_FAIL"
        );

        // Canonical ordering. V3 stores (token0 < token1).
        (address t0, address t1) = p.tokenIn < p.otherToken
            ? (p.tokenIn, p.otherToken)
            : (p.otherToken, p.tokenIn);

        // Resolve the pool. Reverts if no pool exists for this (t0, t1, fee).
        address pool = IUniswapV3Factory(factory).getPool(t0, t1, p.fee);
        require(pool != address(0), "NO_POOL");

        // Half-and-half is the near-optimal split for a max-range position;
        // the trailing fee-induced imbalance gets absorbed by mint()'s
        // desired-vs-min slippage window.
        bool zeroForOne = p.tokenIn == t0;
        uint256 outReceived = _doSwap(pool, p.tokenIn, p.amountIn / 2, zeroForOne);

        // Hand off to the mint helper. Splitting the function avoids the
        // 0.7.6 stack-too-deep limit (without via_ir there are ~16 locals
        // available; the full inline version overshoots).
        (tokenId, liquidity) = _doMint(
            p,
            t0,
            t1,
            pool,
            p.tokenIn == t0 ? p.amountIn - (p.amountIn / 2) : outReceived,
            p.tokenIn == t0 ? outReceived : p.amountIn - (p.amountIn / 2)
        );

        // Sweep any leftover dust back to the user. mint() rounds down on
        // both legs, so a few units typically stay in this contract.
        _sweep(t0, msg.sender);
        _sweep(t1, msg.sender);
    }

    function _doSwap(
        address pool,
        address tokenIn,
        uint256 swapAmount,
        bool zeroForOne
    ) internal returns (uint256 outReceived) {
        _authorisedPool = pool;
        (int256 amount0Delta, int256 amount1Delta) = IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(swapAmount),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn)
        );
        _authorisedPool = address(0);
        outReceived = uint256(-(zeroForOne ? amount1Delta : amount0Delta));
    }

    function _doMint(
        ZapParams calldata p,
        address t0,
        address t1,
        address pool,
        uint256 amount0Desired,
        uint256 amount1Desired
    ) internal returns (uint256 tokenId, uint128 liquidity) {
        // Approve the NPM for exact balances. The NPM consumes the allowance
        // during mint so leaving it set after-the-fact is harmless.
        require(IERC20Min(t0).approve(npm, amount0Desired), "APPROVE0_FAIL");
        require(IERC20Min(t1).approve(npm, amount1Desired), "APPROVE1_FAIL");

        // Align MIN/MAX to the pool's tickSpacing so checkTicks passes.
        int24 spacing = IUniswapV3Pool(pool).tickSpacing();
        int24 tickLower = (MIN_TICK / spacing) * spacing;
        if (tickLower < MIN_TICK) tickLower += spacing;
        int24 tickUpper = (MAX_TICK / spacing) * spacing;
        if (tickUpper > MAX_TICK) tickUpper -= spacing;

        INonfungiblePositionManager.MintParams memory mp = INonfungiblePositionManager.MintParams({
            token0: t0,
            token1: t1,
            fee: p.fee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: p.amount0Min,
            amount1Min: p.amount1Min,
            recipient: p.recipient,
            deadline: p.deadline
        });
        (tokenId, liquidity, , ) = INonfungiblePositionManager(npm).mint(mp);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        // Auth: only the pool we just initiated a swap on can call back.
        // _authorisedPool is set by zapInMaxRange and cleared right after.
        require(msg.sender == _authorisedPool, "BAD_CALLBACK");
        address tokenIn = abi.decode(data, (address));
        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : uint256(amount1Delta);
        require(IERC20Min(tokenIn).transfer(msg.sender, amountToPay), "PAY_FAIL");
    }

    function _sweep(address token, address to) internal {
        uint256 bal = IERC20Min(token).balanceOf(address(this));
        if (bal > 0) IERC20Min(token).transfer(to, bal);
    }
}
