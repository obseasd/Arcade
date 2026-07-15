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

/// @dev Minimal launchpad surface — the locker reads the paired-token
///      allowlist from the launchpad so it can re-validate a fresh lock,
///      defence-in-depth against the launchpad being miswired (M-06).
interface IArcadeLaunchpadMin {
    function USDC() external view returns (address);
    function weth() external view returns (address);
}

/// @dev Minimal Uniswap V3 factory surface for CSEC-013 pool re-derivation.
interface IArcadeV3FactoryMin {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
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
    /// @dev Audit V3 Locker M-3: owner with restricted rescue power.
    ///      Set in the constructor (typically a multisig). Can only
    ///      sweep tokens that are NEITHER the paired NOR token side of
    ///      ANY active position - so principal LP fees stay locked.
    address public immutable owner;
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

    /// @notice Audit V3 Locker V3-6: append-only refcount of how many
    ///         active positions reference each token on their paired or
    ///         clanker side. Incremented once per side per
    ///         `lockSingleSided` call (so a single position contributes
    ///         +1 for `paired` and +1 for `clanker`). NEVER decremented:
    ///         locker positions are permanent (no decreaseLiquidity / no
    ///         NFT transfer), so any token that has ever been on either
    ///         side of a live position stays referenced forever. Lets
    ///         `adminRescue` run in O(1) instead of iterating
    ///         `positionCount`, which previously bricked past ~3-4k
    ///         positions due to the block gas limit.
    ///         uint16 ceiling (65535) is far above the protocol's
    ///         realistic per-token launch cap; SSTORE on overflow would
    ///         simply revert and block further locks of the same token,
    ///         which is acceptable defense-in-depth.
    mapping(address => uint16) public activeTokenRefCount;

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
    event AdminRescue(address indexed token, address indexed to, uint256 amount);
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
    /// @notice CSEC-005: emitted when an inline payout to the twitterEscrow
    ///         fails (USDC blocklist, escrow paused, escrow rejects). The
    ///         amount is credited to pendingWithdrawals[token][twitterEscrow]
    ///         but `creditSlot` is NOT called, so the escrow's per-slot
    ///         accounting (`balances[positionId][slot][token]`) stays at 0.
    ///         Backend / operator indexes this event to either retry
    ///         `pullFromLocker` + manual `creditSlot` once the recipient is
    ///         unblocked, or to mirror the credit in off-chain state for the
    ///         slot's recipient to claim against. Distinct from
    ///         `EscrowCreditFailed` (which fires when the TRANSFER succeeded
    ///         but the `creditSlot` follow-up reverted).
    event EscrowSlotPendingCredit(
        uint256 indexed positionId,
        uint256 indexed slotIndex,
        address indexed token,
        uint256 amount
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
    constructor(address launchpad_, address factory_, address twitterEscrow_, address owner_) {
        require(launchpad_ != address(0) && factory_ != address(0) && owner_ != address(0), "ZERO");
        launchpad = launchpad_;
        factory = factory_;
        twitterEscrow = twitterEscrow_;
        owner = owner_;
    }

    /**
     * @notice Audit V3 Locker M-3: rescue tokens accidentally sent to
     *         the locker. Only callable by the owner (typically the
     *         multisig). Whitelist of token addresses NEVER allowed:
     *         every position's paired side + launch token. Principal
     *         LP fees cannot be drained.
     * @param token Token address to rescue.
     * @param to Recipient of the rescued balance.
     * @param amount Amount to transfer (must be <= balanceOf(this)).
     */
    function adminRescue(address token, address to, uint256 amount) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(to != address(0), "ZERO_TO");
        // Audit M-2: skip no-op calls so a compromised owner key can't
        // spam AdminRescue events at zero cost.
        if (amount == 0) return;
        // Audit V3 Locker V3-6: O(1) refcount lookup replaces the
        // previous O(positionCount) loop. `activeTokenRefCount[token]`
        // is incremented in `lockSingleSided` for the paired and clanker
        // sides and is never decremented (positions are permanent), so
        // a non-zero count means at least one active position has the
        // token on either side. Preserves the original guard semantics
        // while removing the gas-bomb past ~3-4k positions.
        require(activeTokenRefCount[token] == 0, "ACTIVE_TOKEN");
        _pay(token, to, amount);
        emit AdminRescue(token, to, amount);
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
        uint24 fee; // CSEC-013: pool's fee tier; locker re-derives pool from
        // factory.getPool(token, paired, fee) and requires it == p.pool. Closes
        // a defence-in-depth gap where a miswired launchpad could feed an
        // arbitrary `pool` address that passed only `IUniswapV3Pool` interface
        // duck-typing.
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
        // M-06: re-validate `paired ∈ {USDC, WETH}` against the launchpad's
        // immutable allowlist. The launchpad already enforces this via its
        // pool-type selector, but the locker has historically trusted whatever
        // it was passed. If the launchpad ever ships a regression that lets a
        // creator slip an arbitrary `paired` through, this guard stops a
        // malicious-token reentrancy via _payOrCredit's inline transfer.
        // Note: clankerToken (p.token) is the launch token and is always
        // safe (ArcadeLaunchToken is a plain OZ ERC20 minted by the launchpad).
        {
            address u = IArcadeLaunchpadMin(launchpad).USDC();
            address w = IArcadeLaunchpadMin(launchpad).weth();
            require(p.paired == u || (w != address(0) && p.paired == w), "BAD_PAIRED");
            require(p.token != p.paired, "SAME_TOKEN");
        }
        // CSEC-013: re-derive the pool address from the canonical factory
        // and require it matches `p.pool`. Defense-in-depth against a
        // miswired (or compromised) launchpad supplying a fake pool address
        // that quacks like IUniswapV3Pool.
        {
            address expected = IArcadeV3FactoryMin(factory).getPool(p.token, p.paired, p.fee);
            require(expected != address(0) && expected == p.pool, "BAD_POOL");
        }
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

        // Audit V3 Locker V3-6: tag both sides as "active forever" so
        // adminRescue's O(1) refcount lookup will block any rescue of a
        // token that has ever been the paired or clanker side of an
        // active position. Increment in unchecked-like style via a
        // require-on-overflow read: 0.7.6 has no `unchecked` but the
        // SafeMath-like default revert on overflow is precisely the
        // behavior we want (overflow would mean >65535 active locks of
        // the same token, which would silently break the guard if we
        // wrapped). The +1 SSTORE per side is the only added cost
        // versus the previous loop on every adminRescue call.
        activeTokenRefCount[p.token] += 1;
        activeTokenRefCount[p.paired] += 1;

        liquidity = _mintAll(positionId, p, n);

        for (uint256 i; i < p.recipients.length; ++i) {
            _recipients[positionId].push(p.recipients[i]);
        }
        positionIdByToken[p.token] = positionId;

        // Audit V3 Locker H-1: sweep token-side dust to recipient[0]
        // (creator) instead of the launchpad. The launchpad has no
        // generic ERC20 withdrawal path, so dust sent there would be
        // stuck forever. Routing to recipient[0] gifts the creator a
        // negligible amount of their own token; over the lifetime of
        // the pool the amount is dust by definition.
        // Audit M-3: if recipient[0] IS the Twitter escrow, the dust
        // would arrive without per-slot creditSlot accounting and end
        // up as free-balance the escrow owner could rescue. Skip the
        // sweep in that case. Fee audit 2026-07-02 LOW-5: the few wei of
        // dust then stays in the locker PERMANENTLY. adminRescue cannot
        // reclaim it, because the launch token's activeTokenRefCount is
        // incremented on lock and never decremented (positions are
        // permanent), so its refcount is always >= 1 and adminRescue's
        // `activeTokenRefCount == 0` guard can never pass. This is an
        // accepted dust-scale loss, not a deferred recovery.
        address sweepTo = p.recipients[0].recipient;
        if (sweepTo != twitterEscrow) _sweep(p.token, sweepTo);
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
        // Anchor the bands beyond the pool's LIVE tick as well as the intended
        // price. pool.mint computes owed amounts from slot0.tick, not from the
        // passed sqrtPriceX96, so if someone pre-initialized the pool at an
        // out-of-band tick, bands anchored only to the intended price would
        // straddle the live tick and make mint owe the paired token the locker
        // does not hold -> TRANSFER_FAIL -> the whole launch bricks. Clamping to
        // max(live,intended) (token0) / min(live,intended) (token1) keeps every
        // mint single-sided against the live tick while never selling supply
        // past the intended FDV (so the 2026-06-29 steal-the-supply stays shut).
        (, int24 liveTick,,,,,) = IUniswapV3Pool(p.pool).slot0();
        (int24[3] memory lowers, int24[3] memory uppers) =
            _computeRanges(tokenIsToken0, p.sqrtPriceX96, liveTick, IUniswapV3Pool(p.pool).tickSpacing(), n);

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
    function _computeRanges(bool tokenIsToken0, uint160 sqrtPriceX96, int24 liveTick, int24 spacing, uint8 n)
        internal
        pure
        returns (int24[3] memory lowers, int24[3] memory uppers)
    {
        int24 intendedTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        // token0 launch: sell ABOVE the higher of (live, intended) so mint is
        // token0-only and price never opens below intent. token1 launch: sell
        // BELOW the lower of (live, intended), symmetric.
        int24 cur = tokenIsToken0
            ? (liveTick > intendedTick ? liveTick : intendedTick)
            : (liveTick < intendedTick ? liveTick : intendedTick);
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
        // Audit V3 Locker H-2: short-circuit when the locker owns zero
        // liquidity in this range. positions() returns default zeros
        // and ticks() returns zeroed feeGrowthOutside on a never-
        // initialised tick, so the fee-growth-inside math degenerates
        // to fg_global (the global fee growth since pool init), and
        // owed*+(liq*d)/(1<<128) just returns owed* (which is 0). The
        // bug surfaces only if liq=0 with non-zero owed, which can't
        // happen post-creation but the early-return matches Uniswap's
        // own convention and removes the dead read.
        if (liq == 0) return (uint256(owed0), uint256(owed1));
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
        // Audit V3 Locker V3-1: read the `initialized` flag from the
        // pool's ticks() tuple (9th field in v3-core). If the tick has
        // never had a position cross it, all feeGrowthOutside fields
        // are zero AND the position is not yet in the bitmap; treating
        // those zeros as a real "outside" value makes the else-branch
        // compute below0 = fg_global - 0 = fg_global, and the caller's
        // fgi = fg - below - above underflows on the wraparound
        // subtraction. Short-circuit to (0, 0) on uninitialised ticks
        // so previewFees returns 0 instead of garbage.
        (, , uint256 lower0, uint256 lower1, , , , bool initialized) =
            IUniswapV3Pool(c.pool).ticks(tickLower);
        if (!initialized) return (0, 0);
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
        // Audit V3 Locker V3-1: same uninitialised-tick guard as _below.
        (, , uint256 upper0, uint256 upper1, , , , bool initialized) =
            IUniswapV3Pool(c.pool).ticks(tickUpper);
        if (!initialized) return (0, 0);
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

        // CREDIT BEFORE TRANSFER (audit 2026-07-11 MEDIUM-1).
        //
        // This used to transfer first and then try/catch creditSlot, with the
        // catch merely emitting an event. But by then the tokens were already
        // in the escrow, so `pendingWithdrawals` below was UNREACHABLE for this
        // path and `pullFromLocker` had nothing to pull. The escrow held them
        // with balances[posId][slot][token] == 0 and creditedTotal[token] == 0,
        // i.e. as unattributed "free balance" that ONLY the owner's rescue()
        // could move. The user's fees silently became treasury-rescuable.
        //
        // Not theoretical: claimByTwitter sets claimed[posId][slot] = true and
        // then calls rotateSlot best-effort in a try/catch. If that rotation
        // reverts, the slot still points at the escrow while claimed == true,
        // so EVERY later (permissionless) collectFees hits SlotAlreadyClaimed
        // here. A live 8000bps slot would funnel its whole share into the
        // treasury's rescuable balance, indefinitely.
        //
        // So: attribute first, and only send what the escrow accepted. On
        // failure the tokens stay HERE, where pullFromLocker can recover them,
        // which is what the old comment already (wrongly) claimed happened.
        if (to == twitterEscrow && twitterEscrow != address(0)) {
            try IArcadeTwitterEscrowMin(twitterEscrow).creditSlot(positionId, slotIndex, token, amount) {
                // Attributed. Fall through and deliver the tokens it represents.
            } catch (bytes memory reason) {
                pendingWithdrawals[token][to] += amount;
                emit EscrowCreditFailed(positionId, slotIndex, token, amount, reason);
                emit EscrowSlotPendingCredit(positionId, slotIndex, token, amount);
                emit RecipientCredited(positionId, slotIndex, token, to, amount);
                return;
            }
        }

        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        // M-14: defensive decode. abi.decode reverts on a return shorter than
        // 32 bytes (a malicious or non-standard token could return 1 byte and
        // brick this distribution path). Treat any short non-empty return as
        // a failure rather than letting it bubble up and revert collectFees.
        bool decoded = ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool)));
        if (ok && decoded) {
            emit RecipientPaid(positionId, slotIndex, token, to, amount);
            return;
        }
        // RESIDUAL, documented: if `to` is the escrow, the credit above already
        // landed, so crediting pendingWithdrawals here double-counts against an
        // escrow balance it never received. That needs the token itself to
        // fail a transfer to our own escrow, which the launch token and USDC do
        // not do; the distinct event lets ops reconcile if it ever happens. We
        // still do NOT revert, keeping M-14's property that one bad token can
        // never brick distribution to the OTHER slots in the same collectFees.
        if (to == twitterEscrow && twitterEscrow != address(0)) {
            emit EscrowCreditFailed(positionId, slotIndex, token, amount, bytes("TRANSFER_AFTER_CREDIT"));
        }
        pendingWithdrawals[token][to] += amount;
        emit RecipientCredited(positionId, slotIndex, token, to, amount);
        // CSEC-005: surface the position+slot for indexers when the failed
        // recipient is the Twitter escrow, so off-chain bookkeeping can
        // mirror the missing creditSlot. RecipientCredited carries the
        // recipient (= twitterEscrow), but the position+slot index lets
        // operators reconcile against escrow's `balances[posId][slot]` map.
        if (to == twitterEscrow && twitterEscrow != address(0)) {
            emit EscrowSlotPendingCredit(positionId, slotIndex, token, amount);
        }
    }

    /// @notice Withdraw any pending payouts of `token` credited to `msg.sender`
    /// from past failed direct transfers (eg blacklist that has since cleared).
    /// Permissionless; always pays the caller.
    function withdrawPending(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingWithdrawals[token][msg.sender];
        require(amount > 0, "NOTHING");
        pendingWithdrawals[token][msg.sender] = 0;
        // Audit V3 Locker H-4: ledger is set to 0 BEFORE _pay so a
        // revert here rolls back BOTH the SSTORE and the transfer
        // attempt - the row is preserved for a retry. If _pay
        // succeeds the ledger stays at 0. There is no partial-state
        // window. Comment was previously misleading.
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
        // Audit L-4: enforce (recipient == escrow) <=> (admin == escrow).
        // Launchpad sets this invariant at creation; without enforcing it
        // post-rotation a non-escrow admin could re-route fees to the
        // escrow address mid-life and strand them there because the
        // escrow has no slot attribution for an unbound payout.
        address esc = twitterEscrow;
        if (newRecipient == esc) {
            require(r.admin == esc, "ESCROW_PAIR");
        } else {
            require(r.admin != esc, "ESCROW_PAIR");
        }
        r.recipient = newRecipient;
        emit RecipientUpdated(positionId, index, newRecipient);
    }

    /// @notice Rotate a recipient slot's admin. Only the current admin.
    function updateAdmin(uint256 positionId, uint256 index, address newAdmin) external {
        require(newAdmin != address(0), "ZERO");
        Recipient storage r = _recipients[positionId][index];
        require(msg.sender == r.admin, "ONLY_ADMIN");
        // Audit L-4: mirror the symmetric escrow-pair check.
        address esc = twitterEscrow;
        if (newAdmin == esc) {
            require(r.recipient == esc, "ESCROW_PAIR");
        } else {
            require(r.recipient != esc, "ESCROW_PAIR");
        }
        r.admin = newAdmin;
        emit AdminUpdated(positionId, index, newAdmin);
    }

    /// @notice Atomically rotate BOTH a slot's recipient and admin in one tx.
    /// @dev Audit 2026-06-11 CONTRACT-2: the L-4 invariant
    /// `(recipient == escrow) <=> (admin == escrow)` is correct on the
    /// final state but accidentally locked the canonical `(esc, esc) ->
    /// (user, user)` transition because BOTH `updateRecipient(esc -> user)`
    /// and `updateAdmin(esc -> user)` would have to pass through a
    /// temporarily asymmetric state that the single-field setters reject.
    /// Result: every slot routed through TwitterEscrow stranded after the
    /// first `claimByTwitter`, requiring per-token owner rescue. This
    /// atomic setter takes both new values, writes both, and applies the
    /// invariant ONLY on the final state — preserving the L-4 security
    /// posture while unlocking the legitimate rotation path. Caller must
    /// still be the current admin (so the TwitterEscrow can sign-and-call
    /// this from inside `claimByTwitter`, where it already holds the
    /// admin role on credited slots).
    function rotateSlot(
        uint256 positionId,
        uint256 index,
        address newRecipient,
        address newAdmin
    ) external {
        require(newRecipient != address(0) && newAdmin != address(0), "ZERO");
        Recipient storage r = _recipients[positionId][index];
        require(msg.sender == r.admin, "ONLY_ADMIN");
        address esc = twitterEscrow;
        // Invariant on the FINAL state only — intermediate writes can be
        // asymmetric because they happen atomically in this single call.
        if (newRecipient == esc) {
            require(newAdmin == esc, "ESCROW_PAIR");
        } else {
            require(newAdmin != esc, "ESCROW_PAIR");
        }
        r.recipient = newRecipient;
        r.admin = newAdmin;
        emit RecipientUpdated(positionId, index, newRecipient);
        emit AdminUpdated(positionId, index, newAdmin);
    }

    // ====================== Internal token transfers ======================

    function _pay(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        // M-14: same defensive decode as _payOrCredit. Reverts cleanly on
        // non-standard tokens instead of bubbling an abi.decode panic.
        require(ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool)))), "TRANSFER_FAIL");
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
