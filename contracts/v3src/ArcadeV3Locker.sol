// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";

/// @dev Minimal ERC20 surface (avoids pulling an OZ version incompatible with 0.7.6).
interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title ArcadeV3Locker
 * @notice Holds Uniswap V3 full-range liquidity positions PERMANENTLY on behalf
 *         of migrated launchpad tokens (the "Clanker mode"). The locker is the
 *         owner of every position it mints, and it exposes NO path that burns a
 *         non-zero amount of liquidity or transfers the position out — so the
 *         principal can never be withdrawn or rugged.
 *
 *         The only value extractable is the swap fees the position accrues,
 *         which `collectFees` splits between the token creator and the Arcade
 *         treasury (default 80% creator / 20% platform). The creator's right to
 *         that fee stream is transferable via `transferCreator` WITHOUT ever
 *         exposing the locked principal — this is the one useful property of an
 *         NFT position, kept here decoupled from any rug vector.
 *
 *         Written in Solidity 0.7.6 so it can use the canonical Uniswap V3
 *         math libraries verbatim (no risky re-implementation). The 0.8 Arcade
 *         launchpad calls it through an ABI interface.
 */
contract ArcadeV3Locker is IUniswapV3MintCallback {
    /// @notice The Arcade launchpad — the only address allowed to lock new positions.
    address public immutable launchpad;
    /// @notice The canonical V3 factory; used to authenticate mint callbacks.
    address public immutable factory;

    uint256 internal constant BPS = 10_000;

    struct Position {
        address pool;
        address token0;
        address token1;
        int24 tickLower;
        int24 tickUpper;
        address creator; // receives creatorBps of fees
        address platform; // receives the remainder
        uint16 creatorBps;
        bool exists;
    }

    /// positionId => Position. positionId is assigned sequentially.
    mapping(uint256 => Position) public positions;
    uint256 public positionCount;
    /// launchpad token => positionId (+1, so 0 means "none")
    mapping(address => uint256) public positionIdByToken;

    // transient guard: the pool we expect a mint callback from, set during lock.
    address private _expectedPool;
    uint256 private _locked = 1;

    event PositionLocked(
        uint256 indexed positionId,
        address indexed token,
        address pool,
        uint128 liquidity,
        address creator,
        address platform,
        uint16 creatorBps
    );
    event FeesCollected(uint256 indexed positionId, uint256 amount0, uint256 amount1);
    event CreatorTransferred(uint256 indexed positionId, address indexed from, address indexed to);

    modifier nonReentrant() {
        require(_locked == 1, "REENTRANT");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address launchpad_, address factory_) {
        require(launchpad_ != address(0) && factory_ != address(0), "ZERO");
        launchpad = launchpad_;
        factory = factory_;
    }

    /// @notice Parameters for `lockFullRange`, grouped into a struct to keep
    /// the 0.7.6 (no-IR) stack shallow.
    struct LockParams {
        address pool;
        address token0;
        address token1;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Max;
        uint256 amount1Max;
        address creator;
        address platform;
        uint16 creatorBps;
    }

    /**
     * @notice Lock a full-range position. The launchpad must have transferred
     * `amount0Max`/`amount1Max` of the pool tokens to this locker beforehand.
     * Any token not consumed by the mint is returned to the launchpad.
     * @dev `token0`/`token1` must be the pool's actual sorted tokens.
     */
    function lockFullRange(LockParams calldata p)
        external
        nonReentrant
        returns (uint256 positionId, uint128 liquidity)
    {
        require(msg.sender == launchpad, "ONLY_LAUNCHPAD");
        require(p.creator != address(0) && p.platform != address(0), "ZERO_RECEIVER");
        require(p.creatorBps <= BPS, "BAD_BPS");
        require(positionIdByToken[p.token1] == 0 && positionIdByToken[p.token0] == 0, "EXISTS");

        liquidity = _mintPosition(p);

        positionId = ++positionCount;
        positions[positionId] = Position({
            pool: p.pool,
            token0: p.token0,
            token1: p.token1,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            creator: p.creator,
            platform: p.platform,
            creatorBps: p.creatorBps,
            exists: true
        });
        // Map both tokens (one is USDC, one is the launch token); harmless either way.
        positionIdByToken[p.token0] = positionId;
        positionIdByToken[p.token1] = positionId;

        // Return any leftover tokens to the launchpad (mint rounds down).
        _sweep(p.token0, launchpad);
        _sweep(p.token1, launchpad);

        emit PositionLocked(positionId, p.token1, p.pool, liquidity, p.creator, p.platform, p.creatorBps);
    }

    /// @notice Parameters for `lockSingleSided`.
    struct SingleSidedParams {
        address pool;
        address token; // the launch token supplied single-sided (the only asset)
        uint160 sqrtPriceX96; // the pool's initialized start price
        uint256 tokenAmount; // amount of `token` to lock
        address creator;
        address platform;
        uint16 creatorBps;
    }

    /**
     * @notice Lock a SINGLE-SIDED full-supply position (Clanker style). Only the
     * launch token is provided; the position sits entirely on one side of the
     * start price so no quote asset (USDC) is needed at launch. As the token is
     * bought the price moves through the range and USDC accumulates in the pool.
     * The launchpad must have transferred `tokenAmount` of `token` here first.
     */
    function lockSingleSided(SingleSidedParams calldata p)
        external
        nonReentrant
        returns (uint256 positionId, uint128 liquidity)
    {
        require(msg.sender == launchpad, "ONLY_LAUNCHPAD");
        require(p.creator != address(0) && p.platform != address(0), "ZERO_RECEIVER");
        require(p.creatorBps <= BPS, "BAD_BPS");
        require(positionIdByToken[p.token] == 0, "EXISTS");

        address token0 = IUniswapV3Pool(p.pool).token0();
        address token1 = IUniswapV3Pool(p.pool).token1();
        int24 spacing = IUniswapV3Pool(p.pool).tickSpacing();
        (int24 tickLower, int24 tickUpper) = _singleSidedRange(p.token == token0, p.sqrtPriceX96, spacing);

        liquidity = _mintSingleSided(p, token0, tickLower, tickUpper);

        positionId = ++positionCount;
        positions[positionId] = Position({
            pool: p.pool,
            token0: token0,
            token1: token1,
            tickLower: tickLower,
            tickUpper: tickUpper,
            creator: p.creator,
            platform: p.platform,
            creatorBps: p.creatorBps,
            exists: true
        });
        positionIdByToken[p.token] = positionId;

        _sweep(p.token, launchpad);

        emit PositionLocked(positionId, p.token, p.pool, liquidity, p.creator, p.platform, p.creatorBps);
    }

    function _mintSingleSided(SingleSidedParams calldata p, address token0, int24 tickLower, int24 tickUpper)
        internal
        returns (uint128 liquidity)
    {
        bool tokenIsToken0 = p.token == token0;
        // The token is the ONLY asset; place its amount on the right side.
        uint256 amount0 = tokenIsToken0 ? p.tokenAmount : 0;
        uint256 amount1 = tokenIsToken0 ? 0 : p.tokenAmount;
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            p.sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            amount0,
            amount1
        );
        require(liquidity > 0, "ZERO_LIQUIDITY");
        _expectedPool = p.pool;
        IUniswapV3Pool(p.pool).mint(
            address(this), tickLower, tickUpper, liquidity, abi.encode(token0, IUniswapV3Pool(p.pool).token1())
        );
        _expectedPool = address(0);
    }

    /// @dev Computes the single-sided tick range. If the supplied token is
    /// token0, the range sits ABOVE the current price ([above, max]); if it's
    /// token1, BELOW ([min, below]). Either way the current price is outside the
    /// range so only the one token is required.
    function _singleSidedRange(bool tokenIsToken0, uint160 sqrtPriceX96, int24 spacing)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        int24 cur = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        int24 maxUsable = (TickMath.MAX_TICK / spacing) * spacing;
        int24 minUsable = -maxUsable;
        if (tokenIsToken0) {
            // Range strictly above the current tick.
            tickLower = _floorTick(cur, spacing) + spacing;
            tickUpper = maxUsable;
            require(tickLower < tickUpper, "RANGE");
        } else {
            // Range strictly below the current tick.
            tickLower = minUsable;
            tickUpper = _floorTick(cur, spacing);
            require(tickLower < tickUpper, "RANGE");
        }
    }

    /// @dev Floor a tick to the spacing, rounding toward negative infinity.
    function _floorTick(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && (tick % spacing != 0)) compressed--;
        return compressed * spacing;
    }

    /// @dev Computes the full-range liquidity for the supplied amounts and mints
    /// it to this locker. Split out of `lockFullRange` to keep the stack shallow.
    function _mintPosition(LockParams calldata p) internal returns (uint128 liquidity) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(p.pool).slot0();
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(p.tickLower),
            TickMath.getSqrtRatioAtTick(p.tickUpper),
            p.amount0Max,
            p.amount1Max
        );
        require(liquidity > 0, "ZERO_LIQUIDITY");
        // Authenticate the upcoming callback to this exact pool.
        _expectedPool = p.pool;
        IUniswapV3Pool(p.pool).mint(
            address(this), p.tickLower, p.tickUpper, liquidity, abi.encode(p.token0, p.token1)
        );
        _expectedPool = address(0);
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external override {
        require(msg.sender == _expectedPool, "BAD_CALLBACK");
        (address token0, address token1) = abi.decode(data, (address, address));
        if (amount0Owed > 0) _pay(token0, msg.sender, amount0Owed);
        if (amount1Owed > 0) _pay(token1, msg.sender, amount1Owed);
    }

    /**
     * @notice Collect accrued swap fees for a locked position and split them
     * creator/platform. Permissionless — anyone can poke it; fees only ever go
     * to the registered receivers. Pokes the position with a zero-liquidity
     * burn first so `collect` realises the latest fees. NEVER burns a non-zero
     * amount, so principal is untouched.
     */
    function collectFees(uint256 positionId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        Position memory p = positions[positionId];
        require(p.exists, "NO_POSITION");

        // Poke: burning zero liquidity updates owed fees without touching principal.
        IUniswapV3Pool(p.pool).burn(p.tickLower, p.tickUpper, 0);

        (uint128 c0, uint128 c1) = IUniswapV3Pool(p.pool).collect(
            address(this), p.tickLower, p.tickUpper, type(uint128).max, type(uint128).max
        );
        amount0 = c0;
        amount1 = c1;

        _splitAndPay(p.token0, c0, p.creator, p.platform, p.creatorBps);
        _splitAndPay(p.token1, c1, p.creator, p.platform, p.creatorBps);

        emit FeesCollected(positionId, amount0, amount1);
    }

    /// @notice Transfer the creator fee-rights of a position. Only the current
    /// creator can call. Does NOT affect the locked principal in any way.
    function transferCreator(uint256 positionId, address newCreator) external {
        require(newCreator != address(0), "ZERO");
        Position storage p = positions[positionId];
        require(p.exists, "NO_POSITION");
        require(msg.sender == p.creator, "ONLY_CREATOR");
        emit CreatorTransferred(positionId, p.creator, newCreator);
        p.creator = newCreator;
    }

    // ---- internal ----

    function _splitAndPay(address token, uint256 amount, address creator, address platform, uint16 creatorBps)
        internal
    {
        if (amount == 0) return;
        uint256 creatorCut = (amount * creatorBps) / BPS;
        uint256 platformCut = amount - creatorCut;
        if (creatorCut > 0) _pay(token, creator, creatorCut);
        if (platformCut > 0) _pay(token, platform, platformCut);
    }

    function _pay(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "TRANSFER_FAIL");
    }

    function _sweep(address token, address to) internal {
        uint256 bal = IERC20Minimal(token).balanceOf(address(this));
        if (bal > 0) _pay(token, to, bal);
    }

    // ---- views ----

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }
}
