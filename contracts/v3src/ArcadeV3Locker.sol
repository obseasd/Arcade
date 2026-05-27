// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";

/// @dev Minimal ERC20 surface (avoids an OZ version incompatible with 0.7.6).
interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title ArcadeV3Locker
 * @notice Permanently custodies single-sided Uniswap V3 launch positions and
 *         routes their swap fees to up to MAX_RECIPIENTS configurable
 *         recipients. The principal can never be withdrawn (no decreaseLiquidity
 *         / no NFT transfer / only burn(0) for fee poking is ever called).
 *
 *         Each recipient has: a payout address, an admin (who can rotate the
 *         payout address / admin), a weight in bps, and a reward-token
 *         preference (Both / Paired=USDC side / Clanker=launch-token side).
 *         Fees accrue in two pots (paired + clanker); within each pot the
 *         eligible recipients share it by bps weight. This distributes 100% of
 *         each pot with no swaps.
 *
 *         Written in 0.7.6 to use the canonical Uniswap V3 math verbatim.
 */
contract ArcadeV3Locker is IUniswapV3MintCallback {
    address public immutable launchpad;
    address public immutable factory;

    uint256 internal constant BPS = 10_000;
    uint8 public constant MAX_RECIPIENTS = 3;

    enum RewardToken {Both, Paired, Clanker}

    struct Recipient {
        address recipient;
        address admin;
        uint16 bps;
        RewardToken tokenPref;
    }

    struct Position {
        address pool;
        address token0;
        address token1;
        address clankerToken; // the launch token
        address pairedToken; // the quote token (USDC)
        int24 tickLower;
        int24 tickUpper;
        bool exists;
    }

    mapping(uint256 => Position) public positions;
    mapping(uint256 => Recipient[]) internal _recipients;
    uint256 public positionCount;
    mapping(address => uint256) public positionIdByToken;

    // transient guard for the mint callback
    address private _expectedPool;
    uint256 private _locked = 1;

    event PositionLocked(uint256 indexed positionId, address indexed token, address pool, uint128 liquidity);
    event FeesCollected(uint256 indexed positionId, uint256 pairedAmount, uint256 clankerAmount);
    event RecipientUpdated(uint256 indexed positionId, uint256 index, address indexed newRecipient);
    event AdminUpdated(uint256 indexed positionId, uint256 index, address indexed newAdmin);

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

    // ====================== Locking ======================

    struct SingleSidedParams {
        address pool;
        address paired; // USDC
        address token; // launch token
        uint160 sqrtPriceX96; // pool's initialized start price
        uint256 tokenAmount; // amount of `token` to lock single-sided
        Recipient[] recipients;
    }

    /**
     * @notice Lock a single-sided full-supply position and register its fee
     * recipients. The launchpad must have transferred `tokenAmount` of `token`
     * to this locker first. Only the launch token is supplied; the position
     * sits above the start price so no quote asset is needed at launch.
     */
    function lockSingleSided(SingleSidedParams calldata p)
        external
        nonReentrant
        returns (uint256 positionId, uint128 liquidity)
    {
        require(msg.sender == launchpad, "ONLY_LAUNCHPAD");
        require(positionIdByToken[p.token] == 0, "EXISTS");
        _validateRecipients(p.recipients);

        address token0 = IUniswapV3Pool(p.pool).token0();
        address token1 = IUniswapV3Pool(p.pool).token1();
        int24 spacing = IUniswapV3Pool(p.pool).tickSpacing();
        (int24 tickLower, int24 tickUpper) = _singleSidedRange(p.token == token0, p.sqrtPriceX96, spacing);

        liquidity = _mintSingleSided(p, token0, token1, tickLower, tickUpper);

        positionId = ++positionCount;
        positions[positionId] = Position({
            pool: p.pool,
            token0: token0,
            token1: token1,
            clankerToken: p.token,
            pairedToken: p.paired,
            tickLower: tickLower,
            tickUpper: tickUpper,
            exists: true
        });
        for (uint256 i; i < p.recipients.length; ++i) {
            _recipients[positionId].push(p.recipients[i]);
        }
        positionIdByToken[p.token] = positionId;

        _sweep(p.token, launchpad);
        emit PositionLocked(positionId, p.token, p.pool, liquidity);
    }

    function _validateRecipients(Recipient[] calldata rs) internal pure {
        require(rs.length >= 1 && rs.length <= MAX_RECIPIENTS, "RECIPIENTS");
        uint256 total;
        bool hasPaired;
        bool hasClanker;
        for (uint256 i; i < rs.length; ++i) {
            require(rs[i].recipient != address(0) && rs[i].admin != address(0), "ZERO_ADDR");
            require(rs[i].bps > 0, "ZERO_BPS");
            total += rs[i].bps;
            if (rs[i].tokenPref != RewardToken.Clanker) hasPaired = true; // Both or Paired
            if (rs[i].tokenPref != RewardToken.Paired) hasClanker = true; // Both or Clanker
        }
        require(total == BPS, "BPS_SUM");
        // Ensure each fee pot has at least one eligible recipient so 100% distributes.
        require(hasPaired && hasClanker, "NEED_BOTH_SIDES");
    }

    function _mintSingleSided(
        SingleSidedParams calldata p,
        address token0,
        address token1,
        int24 tickLower,
        int24 tickUpper
    ) internal returns (uint128 liquidity) {
        bool tokenIsToken0 = p.token == token0;
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
        IUniswapV3Pool(p.pool).mint(address(this), tickLower, tickUpper, liquidity, abi.encode(token0, token1));
        _expectedPool = address(0);
    }

    function _singleSidedRange(bool tokenIsToken0, uint160 sqrtPriceX96, int24 spacing)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        int24 cur = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        int24 maxUsable = (TickMath.MAX_TICK / spacing) * spacing;
        int24 minUsable = -maxUsable;
        if (tokenIsToken0) {
            tickLower = _floorTick(cur, spacing) + spacing;
            tickUpper = maxUsable;
        } else {
            tickLower = minUsable;
            tickUpper = _floorTick(cur, spacing);
        }
        require(tickLower < tickUpper, "RANGE");
    }

    function _floorTick(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && (tick % spacing != 0)) compressed--;
        return compressed * spacing;
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external override {
        require(msg.sender == _expectedPool, "BAD_CALLBACK");
        (address token0, address token1) = abi.decode(data, (address, address));
        if (amount0Owed > 0) _pay(token0, msg.sender, amount0Owed);
        if (amount1Owed > 0) _pay(token1, msg.sender, amount1Owed);
    }

    // ====================== Fee collection ======================

    /**
     * @notice Collect accrued swap fees and distribute them to the position's
     * recipients. Permissionless. Pokes with a zero-liquidity burn first so
     * `collect` realises the latest fees; never burns a non-zero amount.
     */
    function collectFees(uint256 positionId)
        external
        nonReentrant
        returns (uint256 pairedAmount, uint256 clankerAmount)
    {
        Position memory p = positions[positionId];
        require(p.exists, "NO_POSITION");

        IUniswapV3Pool(p.pool).burn(p.tickLower, p.tickUpper, 0);
        (uint128 c0, uint128 c1) = IUniswapV3Pool(p.pool).collect(
            address(this), p.tickLower, p.tickUpper, type(uint128).max, type(uint128).max
        );

        pairedAmount = p.pairedToken == p.token0 ? uint256(c0) : uint256(c1);
        clankerAmount = p.clankerToken == p.token0 ? uint256(c0) : uint256(c1);

        _distributePot(positionId, p.pairedToken, pairedAmount, true);
        _distributePot(positionId, p.clankerToken, clankerAmount, false);

        emit FeesCollected(positionId, pairedAmount, clankerAmount);
    }

    /// @dev Distributes `amount` of `token` to the recipients eligible for this
    /// pot, weighted by bps. `forPaired` selects the pot (paired vs clanker).
    function _distributePot(uint256 positionId, address token, uint256 amount, bool forPaired) internal {
        if (amount == 0) return;
        Recipient[] storage rs = _recipients[positionId];
        uint256 totalW;
        for (uint256 i; i < rs.length; ++i) {
            if (_eligible(rs[i].tokenPref, forPaired)) totalW += rs[i].bps;
        }
        if (totalW == 0) return;

        uint256 distributed;
        uint256 lastIdx = type(uint256).max;
        for (uint256 i; i < rs.length; ++i) {
            if (_eligible(rs[i].tokenPref, forPaired)) lastIdx = i;
        }
        for (uint256 i; i < rs.length; ++i) {
            if (!_eligible(rs[i].tokenPref, forPaired)) continue;
            // The last eligible recipient absorbs any rounding dust.
            uint256 share = i == lastIdx ? amount - distributed : (amount * rs[i].bps) / totalW;
            distributed += share;
            if (share > 0) _pay(token, rs[i].recipient, share);
        }
    }

    function _eligible(RewardToken pref, bool forPaired) internal pure returns (bool) {
        return forPaired ? pref != RewardToken.Clanker : pref != RewardToken.Paired;
    }

    // ====================== Recipient admin ======================

    /// @notice Rotate a recipient's payout address. Only that slot's admin.
    function updateRecipient(uint256 positionId, uint256 index, address newRecipient) external {
        require(newRecipient != address(0), "ZERO");
        Recipient storage r = _recipients[positionId][index];
        require(msg.sender == r.admin, "ONLY_ADMIN");
        r.recipient = newRecipient;
        emit RecipientUpdated(positionId, index, newRecipient);
    }

    /// @notice Rotate a recipient slot's admin. Only the current admin.
    function updateAdmin(uint256 positionId, uint256 index, address newAdmin) external {
        require(newAdmin != address(0), "ZERO");
        Recipient storage r = _recipients[positionId][index];
        require(msg.sender == r.admin, "ONLY_ADMIN");
        r.admin = newAdmin;
        emit AdminUpdated(positionId, index, newAdmin);
    }

    // ====================== Internal token transfers ======================

    function _pay(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "TRANSFER_FAIL");
    }

    function _sweep(address token, address to) internal {
        uint256 bal = IERC20Min(token).balanceOf(address(this));
        if (bal > 0) _pay(token, to, bal);
    }

    // ====================== Views ======================

    function getRecipients(uint256 positionId) external view returns (Recipient[] memory) {
        return _recipients[positionId];
    }

    function recipientsCount(uint256 positionId) external view returns (uint256) {
        return _recipients[positionId].length;
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }
}
