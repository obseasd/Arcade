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

/// @dev Minimal escrow surface for the on-chain credit-slot integration. Lets
///      the locker tell the V3 Twitter escrow which (positionId, slotIndex,
///      token, amount) was just routed to it, so the escrow can enforce
///      per-slot accounting at claim time.
interface IArcadeTwitterEscrowMin {
    function creditSlot(uint256 positionId, uint256 slotIndex, address token, uint256 amount) external;
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
    /// @notice Optional V3 Twitter escrow. When non-zero, every successful
    ///         direct payout whose recipient equals this address also calls
    ///         `escrow.creditSlot(positionId, slot, token, amount)` so the
    ///         escrow can enforce per-slot accounting at claim time. Wrapped
    ///         in try/catch: a misbehaving escrow never bricks fee
    ///         distribution. Pass `address(0)` to disable the integration
    ///         (legacy behavior - escrow receives tokens with no on-chain
    ///         attribution, claim path falls back on backend-only attestation).
    address public immutable twitterEscrow;

    uint256 internal constant BPS = 10_000;
    uint8 public constant MAX_RECIPIENTS = 4; // up to 3 creator recipients + the platform
    uint8 public constant MAX_RANGES = 3;

    // Tick offsets (from the launch tick) delimiting the 3-position liquidity
    // bands. ~+4x and ~+25x in price. Snapped to the pool's tick spacing.
    int24 internal constant BAND_OFF_1 = 13_800; // e^(13800*1e-4) ~ 3.97x
    int24 internal constant BAND_OFF_2 = 32_200; // e^(32200*1e-4) ~ 25x

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
        address pairedToken; // the quote token (USDC or WETH)
        uint8 numRanges; // 1 (Legacy) or 3 (Project-style)
        int24[3] tickLowers;
        int24[3] tickUppers;
        bool exists;
    }

    mapping(uint256 => Position) internal positions;
    mapping(uint256 => Recipient[]) internal _recipients;
    uint256 public positionCount;
    mapping(address => uint256) public positionIdByToken;

    /// @notice Pull-payment ledger: token => recipient => claimable amount.
    /// Credited whenever a direct payout in `_distributePot` fails (USDC
    /// blacklist, recipient contract reverts, etc.) so one bad recipient can
    /// never DoS the rest of the pot. Recipients pull via `withdrawPending`.
    mapping(address => mapping(address => uint256)) public pendingWithdrawals;

    // transient guard for the mint callback
    address private _expectedPool;
    uint256 private _locked = 1;

    event PositionLocked(uint256 indexed positionId, address indexed token, address pool, uint128 liquidity);
    event FeesCollected(uint256 indexed positionId, uint256 pairedAmount, uint256 clankerAmount);
    /// @notice Emitted once per recipient per `collectFees` call. Lets indexers
    ///         build exact per-slot earnings histories without estimating from
    ///         pool volume + bps.
    event RecipientPaid(
        uint256 indexed positionId,
        uint256 indexed slotIndex,
        address indexed token,
        address recipient,
        uint256 amount
    );
    /// @notice Emitted when a direct payout failed and was credited to the
    /// pull-payment ledger. `recipient` can call `withdrawPending(token)` later.
    event RecipientCredited(
        uint256 indexed positionId,
        uint256 indexed slotIndex,
        address indexed token,
        address recipient,
        uint256 amount
    );
    event PendingWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event RecipientUpdated(uint256 indexed positionId, uint256 index, address indexed newRecipient);
    event AdminUpdated(uint256 indexed positionId, uint256 index, address indexed newAdmin);
    /// @notice Emitted when the locker successfully transferred to the Twitter
    ///         escrow but the escrow rejected `creditSlot` (paused, wrong
    ///         locker authorised, etc). The tokens are in the escrow but its
    ///         on-chain accounting did not update - the backend can retry via
    ///         a manual creditSlot call (with operator role) if needed.
    event EscrowCreditFailed(
        uint256 indexed positionId,
        uint256 indexed slotIndex,
        address indexed token,
        uint256 amount,
        bytes reason
    );

    modifier nonReentrant() {
        require(_locked == 1, "REENTRANT");
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @param launchpad_     Trusted launchpad that calls `lockSingleSided`.
    /// @param factory_       Uniswap V3 factory whose pools we accept.
    /// @param twitterEscrow_ Optional V3 Twitter escrow address. Pass
    ///                       `address(0)` to disable the per-slot accounting
    ///                       integration entirely (legacy behavior); otherwise
    ///                       any successful direct payout to this address is
    ///                       mirrored to `escrow.creditSlot(...)` so the
    ///                       escrow can enforce on-chain balances at claim
    ///                       time. The escrow MUST recognise this locker
    ///                       address as the authorised depositor.
    constructor(address launchpad_, address factory_, address twitterEscrow_) {
        require(launchpad_ != address(0) && factory_ != address(0), "ZERO");
        launchpad = launchpad_;
        factory = factory_;
        twitterEscrow = twitterEscrow_;
    }

    // ====================== Locking ======================

    struct SingleSidedParams {
        address pool;
        address paired; // quote token (USDC or WETH)
        address token; // launch token
        uint160 sqrtPriceX96; // pool's initialized start price
        uint256 tokenAmount; // amount of `token` to lock single-sided
        uint16[] positionBps; // supply split per range; sums to 10000 (len 1 or 3)
        Recipient[] recipients;
    }

    /**
     * @notice Lock a single-sided position (1 or 3 ranges) over the full LP
     * supply and register its fee recipients. The launchpad must have
     * transferred `tokenAmount` of `token` to this locker first. Only the launch
     * token is supplied; every range sits on the far side of the start price so
     * no quote asset is needed at launch. The principal is locked forever.
     */
    function lockSingleSided(SingleSidedParams calldata p)
        external
        nonReentrant
        returns (uint256 positionId, uint128 liquidity)
    {
        require(msg.sender == launchpad, "ONLY_LAUNCHPAD");
        require(positionIdByToken[p.token] == 0, "EXISTS");
        _validateRecipients(p.recipients);
        uint8 n = _validateBps(p.positionBps);

        positionId = ++positionCount;
        {
            Position storage pos = positions[positionId];
            pos.pool = p.pool;
            pos.token0 = IUniswapV3Pool(p.pool).token0();
            pos.token1 = IUniswapV3Pool(p.pool).token1();
            pos.clankerToken = p.token;
            pos.pairedToken = p.paired;
            pos.numRanges = n;
            pos.exists = true;
        }

        liquidity = _mintAll(positionId, p, n);

        for (uint256 i; i < p.recipients.length; ++i) {
            _recipients[positionId].push(p.recipients[i]);
        }
        positionIdByToken[p.token] = positionId;

        _sweep(p.token, launchpad);
        emit PositionLocked(positionId, p.token, p.pool, liquidity);
    }

    function _validateBps(uint16[] calldata bps) internal pure returns (uint8 n) {
        n = uint8(bps.length);
        require(n == 1 || n == 3, "RANGES");
        uint256 s;
        for (uint256 i; i < n; ++i) s += bps[i];
        require(s == BPS, "POS_BPS_SUM");
    }

    /// @dev Mints every single-sided range and records its ticks. Split out of
    /// lockSingleSided to keep the 0.7.6 stack within limits.
    function _mintAll(uint256 positionId, SingleSidedParams calldata p, uint8 n)
        internal
        returns (uint128 liquidity)
    {
        Position storage pos = positions[positionId];
        address token0 = pos.token0;
        address token1 = pos.token1;
        bool tokenIsToken0 = p.token == token0;
        (int24[3] memory lowers, int24[3] memory uppers) =
            _computeRanges(tokenIsToken0, p.sqrtPriceX96, IUniswapV3Pool(p.pool).tickSpacing(), n);

        bytes memory cb = abi.encode(token0, token1);
        _expectedPool = p.pool;
        uint256 remaining = p.tokenAmount;
        for (uint256 i; i < n; ++i) {
            uint256 amt = i == uint256(n) - 1 ? remaining : (p.tokenAmount * p.positionBps[i]) / BPS;
            remaining -= amt;
            uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
                p.sqrtPriceX96,
                TickMath.getSqrtRatioAtTick(lowers[i]),
                TickMath.getSqrtRatioAtTick(uppers[i]),
                tokenIsToken0 ? amt : 0,
                tokenIsToken0 ? 0 : amt
            );
            require(liq > 0, "ZERO_LIQUIDITY");
            IUniswapV3Pool(p.pool).mint(address(this), lowers[i], uppers[i], liq, cb);
            pos.tickLowers[i] = lowers[i];
            pos.tickUppers[i] = uppers[i];
            liquidity += liq;
        }
        _expectedPool = address(0);
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

    /// @dev Computes the 1 or 3 single-sided tick bands sitting on the far side
    /// of the launch price. With 3 ranges the supply concentrates near the start
    /// (band 0 = closest), spreading out to ~4x then ~25x and beyond.
    function _computeRanges(bool tokenIsToken0, uint160 sqrtPriceX96, int24 spacing, uint8 n)
        internal
        pure
        returns (int24[3] memory lowers, int24[3] memory uppers)
    {
        int24 cur = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        int24 maxUsable = (TickMath.MAX_TICK / spacing) * spacing;
        int24 minUsable = -maxUsable;
        int24 o1 = (BAND_OFF_1 / spacing) * spacing;
        int24 o2 = (BAND_OFF_2 / spacing) * spacing;

        if (tokenIsToken0) {
            // Token sits ABOVE the start tick (price of token0 rises as bought).
            int24 base = _floorTick(cur, spacing) + spacing;
            if (n == 1) {
                lowers[0] = base;
                uppers[0] = maxUsable;
            } else {
                lowers[0] = base;
                uppers[0] = base + o1;
                lowers[1] = base + o1;
                uppers[1] = base + o2;
                lowers[2] = base + o2;
                uppers[2] = maxUsable;
            }
        } else {
            // Token sits BELOW the start tick.
            int24 top = _floorTick(cur, spacing);
            if (n == 1) {
                lowers[0] = minUsable;
                uppers[0] = top;
            } else {
                lowers[0] = top - o1;
                uppers[0] = top;
                lowers[1] = top - o2;
                uppers[1] = top - o1;
                lowers[2] = minUsable;
                uppers[2] = top - o2;
            }
        }
        for (uint256 i; i < n; ++i) require(lowers[i] < uppers[i], "RANGE");
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

        // Poke + collect every range, summing the two token pots.
        uint256 sum0;
        uint256 sum1;
        for (uint256 i; i < p.numRanges; ++i) {
            IUniswapV3Pool(p.pool).burn(p.tickLowers[i], p.tickUppers[i], 0);
            (uint128 c0, uint128 c1) = IUniswapV3Pool(p.pool).collect(
                address(this), p.tickLowers[i], p.tickUppers[i], type(uint128).max, type(uint128).max
            );
            sum0 += uint256(c0);
            sum1 += uint256(c1);
        }

        pairedAmount = p.pairedToken == p.token0 ? sum0 : sum1;
        clankerAmount = p.clankerToken == p.token0 ? sum0 : sum1;

        _distributePot(positionId, p.pairedToken, pairedAmount, true);
        _distributePot(positionId, p.clankerToken, clankerAmount, false);

        emit FeesCollected(positionId, pairedAmount, clankerAmount);
    }

    /// @notice Off-chain helper: estimates the LP fees that `collectFees` would
    ///         distribute right now, in (paired, clanker) totals. Sums pending
    ///         per range via the standard Uniswap V3 fee growth math.
    function previewFees(uint256 positionId)
        external
        view
        returns (uint256 pairedAmount, uint256 clankerAmount)
    {
        Position storage pos = positions[positionId];
        if (!pos.exists) return (0, 0);

        (uint256 pending0, uint256 pending1) = _previewSumByPool(pos);

        pairedAmount = pos.pairedToken == pos.token0 ? pending0 : pending1;
        clankerAmount = pos.clankerToken == pos.token0 ? pending0 : pending1;
    }

    /// @dev Holds the per-range computation locals in memory to keep the outer
    ///      function below the 0.7.6 stack limit.
    struct PreviewCtx {
        address pool;
        uint256 fg0;
        uint256 fg1;
        int24 tickCurrent;
    }

    function _previewSumByPool(Position storage pos)
        internal
        view
        returns (uint256 sum0, uint256 sum1)
    {
        PreviewCtx memory c;
        c.pool = pos.pool;
        c.fg0 = IUniswapV3Pool(c.pool).feeGrowthGlobal0X128();
        c.fg1 = IUniswapV3Pool(c.pool).feeGrowthGlobal1X128();
        (, c.tickCurrent, , , , , ) = IUniswapV3Pool(c.pool).slot0();

        for (uint8 i = 0; i < pos.numRanges; i++) {
            (uint256 p0, uint256 p1) = _previewRange(c, pos.tickLowers[i], pos.tickUppers[i]);
            sum0 += p0;
            sum1 += p1;
        }
    }

    function _previewRange(PreviewCtx memory c, int24 tickLower, int24 tickUpper)
        internal
        view
        returns (uint256 pending0, uint256 pending1)
    {
        bytes32 key = keccak256(abi.encodePacked(address(this), tickLower, tickUpper));
        (uint128 liq, uint256 fgi0Last, uint256 fgi1Last, uint128 owed0, uint128 owed1) =
            IUniswapV3Pool(c.pool).positions(key);
        (uint256 fgi0, uint256 fgi1) = _feeGrowthInside(c, tickLower, tickUpper);
        // 256-bit wraparound subtraction; Solidity 0.7.6 underflows silently.
        uint256 d0 = fgi0 - fgi0Last;
        uint256 d1 = fgi1 - fgi1Last;
        pending0 = uint256(owed0) + (uint256(liq) * d0) / (uint256(1) << 128);
        pending1 = uint256(owed1) + (uint256(liq) * d1) / (uint256(1) << 128);
    }

    function _feeGrowthInside(PreviewCtx memory c, int24 tickLower, int24 tickUpper)
        internal
        view
        returns (uint256 fgi0, uint256 fgi1)
    {
        (uint256 below0, uint256 below1) = _below(c, tickLower);
        (uint256 above0, uint256 above1) = _above(c, tickUpper);
        fgi0 = c.fg0 - below0 - above0;
        fgi1 = c.fg1 - below1 - above1;
    }

    function _below(PreviewCtx memory c, int24 tickLower)
        internal
        view
        returns (uint256 below0, uint256 below1)
    {
        (, , uint256 lower0, uint256 lower1, , , , ) = IUniswapV3Pool(c.pool).ticks(tickLower);
        if (c.tickCurrent >= tickLower) {
            below0 = lower0;
            below1 = lower1;
        } else {
            below0 = c.fg0 - lower0;
            below1 = c.fg1 - lower1;
        }
    }

    function _above(PreviewCtx memory c, int24 tickUpper)
        internal
        view
        returns (uint256 above0, uint256 above1)
    {
        (, , uint256 upper0, uint256 upper1, , , , ) = IUniswapV3Pool(c.pool).ticks(tickUpper);
        if (c.tickCurrent < tickUpper) {
            above0 = upper0;
            above1 = upper1;
        } else {
            above0 = c.fg0 - upper0;
            above1 = c.fg1 - upper1;
        }
    }

    /// @dev Distributes `amount` of `token` to the recipients eligible for this
    /// pot, weighted by bps. `forPaired` selects the pot (paired vs clanker).
    /// Emits one `RecipientPaid` per slot that actually received funds, so
    /// indexers can build accurate per-recipient lifetime earnings.
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
            if (share > 0) {
                _payOrCredit(positionId, i, token, rs[i].recipient, share);
            }
        }
    }

    /// @dev Best-effort: try to transfer the recipient's share directly. If the
    /// underlying ERC20 reverts or returns false (eg the recipient is on the
    /// USDC blacklist or is a contract that rejects), credit the amount to the
    /// pull-payment ledger so a single bad recipient cannot brick the whole
    /// fee distribution.
    function _payOrCredit(uint256 positionId, uint256 slotIndex, address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        bool decoded = ret.length == 0 || abi.decode(ret, (bool));
        if (ok && decoded) {
            // Mirror the deposit into the Twitter escrow's on-chain accounting
            // when (and only when) we routed to it. Wrapped in try/catch so a
            // misbehaving / paused escrow never blocks legitimate fee
            // distribution to OTHER slots in the same collectFees call. The
            // backend can manually credit later via an operator role if it
            // ever fails (event provides the {positionId, slot, token, amount}).
            if (to == twitterEscrow && twitterEscrow != address(0)) {
                try IArcadeTwitterEscrowMin(twitterEscrow).creditSlot(positionId, slotIndex, token, amount) {
                    // ok
                } catch (bytes memory reason) {
                    emit EscrowCreditFailed(positionId, slotIndex, token, amount, reason);
                }
            }
            emit RecipientPaid(positionId, slotIndex, token, to, amount);
            return;
        }
        pendingWithdrawals[token][to] += amount;
        emit RecipientCredited(positionId, slotIndex, token, to, amount);
    }

    /// @notice Withdraw any pending payouts of `token` credited to `msg.sender`
    /// from past failed direct transfers (eg blacklist that has since cleared).
    /// Permissionless; always pays the caller.
    function withdrawPending(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingWithdrawals[token][msg.sender];
        require(amount > 0, "NOTHING");
        pendingWithdrawals[token][msg.sender] = 0;
        // If this still reverts the caller can retry once their token status
        // changes; the ledger entry stays at 0 only after a successful transfer.
        _pay(token, msg.sender, amount);
        emit PendingWithdrawn(token, msg.sender, amount);
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

    /// @notice Number of single-sided LP ranges held for this lock (1 or 3).
    function rangeCount(uint256 positionId) external view returns (uint256) {
        return positions[positionId].numRanges;
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }
}
