// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IV3Factory {
    function owner() external view returns (address);
    function setOwner(address _owner) external;
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IV3PoolMin {
    function fee() external view returns (uint24);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;
    function collectProtocol(address recipient, uint128 amount0Requested, uint128 amount1Requested)
        external
        returns (uint128 amount0, uint128 amount1);
    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8 feeProtocol, bool);
}

interface IV3LockerMin {
    struct Position {
        address pool;
        address token0;
        address token1;
        address clankerToken;
        address pairedToken;
        uint8 numRanges;
        int24[3] tickLowers;
        int24[3] tickUppers;
        bool exists;
    }

    function positionIdByToken(address token) external view returns (uint256);
    function getPosition(uint256 positionId) external view returns (Position memory);
}

/**
 * FeeProtocolManager
 *
 * Becomes the Uniswap-V3-fork FACTORY OWNER, so it is the ONLY address that can
 * `setFeeProtocol` / `collectProtocol` / `setOwner` / `enableFeeAmount` on the
 * factory and its pools. The Safe (2-of-3) owns THIS contract, so governance is
 * unchanged: the Safe keeps every lever and can reclaim factory ownership in one
 * call.
 *
 * PURPOSE: enable the Uniswap V3 `feeProtocol` cut (1/N of the LP fee to the
 * protocol) on ORDINARY user pools AUTOMATICALLY, with zero per-pool governance
 * tx, while provably holding LAUNCH/locked (CLANKER_V3) pools at 0 (they already
 * take ~20% via the locker; a feeProtocol on top would double-skim the creator).
 *
 * The whole mechanism is a permissionless, convergent, idempotent `sync(pool)`.
 * Design + adversarial audit invariants baked in:
 *   - Exclusion is POOL-keyed and read from the locker registry (unforgeable),
 *     never a caller argument and never token-keyed (so a second ordinary pool on
 *     a launch token at a different tier is still skimmed).
 *   - A launch pool is held at 0 both by `forceZero` in the launch tx (closes the
 *     create-then-lock front-run) AND by `sync` refusing to enable it.
 *   - `sync` never disables an ordinary pool; only governance / `forceZero` (on a
 *     genuine launch pool) can set 0.
 *   - `collectProtocol` sends to the FIXED treasury; the recipient is never
 *     caller-supplied, so a permissionless harvest cannot be redirected.
 *   - `setOwner` (escape hatch) + `enableFeeAmount` are proxied under the Safe, so
 *     making this contract the factory owner never bricks factory governance.
 *   - Tier defaults are the whitelisted ordinary tiers only (4 on 0.01%/0.05%, 6
 *     on 0.30%/1%); unknown tiers (eg the launch-only 20000/30000) revert.
 */
contract FeeProtocolManager {
    address public immutable factory;
    address public immutable locker;
    address public owner; // the Safe
    address public pendingOwner; // two-step transfer (never brick factory governance)
    address public treasury; // harvest destination (fixed by governance)
    bool public paused;

    /// fee tier => the feeProtocol denominator N (0 = unmanaged, else 4..10).
    mapping(uint24 => uint8) public tierDefault;
    /// fee tier => is this an ordinary tier this manager auto-enables.
    mapping(uint24 => bool) public tierKnown;

    error NotOwner();
    error Paused_();
    error ZeroAddress();
    error BadValue();
    error UnknownTier();
    error NotLaunchPool();
    error NotPendingOwner();
    error NotAPool();

    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnerSet(address indexed owner);
    event TreasurySet(address indexed treasury);
    event PausedSet(bool paused);
    event TierDefaultSet(uint24 indexed fee, uint8 feeProtocol);
    event Synced(address indexed pool, uint8 feeProtocol, bool launch);
    event ForcedZero(address indexed pool);
    event RawSet(address indexed pool, uint8 fp0, uint8 fp1);
    event Harvested(address indexed pool, address indexed to, uint128 amount0, uint128 amount1);
    event FactoryOwnershipTransferred(address indexed to);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _factory, address _locker, address _owner, address _treasury) {
        if (_factory == address(0) || _locker == address(0) || _owner == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
        factory = _factory;
        locker = _locker;
        owner = _owner;
        treasury = _treasury;
        // Uniswap's published schedule: 4 (1/4) on the 0.01% / 0.05% tiers, 6
        // (1/6) on the 0.30% / 1% tiers. Mirroring the leader is the least
        // arguable choice and stays inside v3-core's {0} u [4,10] bound.
        _setTier(100, 4);
        _setTier(500, 4);
        _setTier(3000, 6);
        _setTier(10000, 6);
    }

    // -------------------- permissionless automation --------------------

    /**
     * Drive `pool` to its CORRECT feeProtocol from the live locker registry.
     * Launch/locked pool => (0,0); ordinary known-tier pool => (d,d). Convergent
     * and idempotent: any number of calls, by anyone, land the same state. It can
     * NEVER enable a launch pool and NEVER disable an ordinary pool.
     */
    function sync(address pool) public {
        if (paused) revert Paused_();
        if (!_isCanonicalPool(pool)) revert NotAPool(); // L-1: real factory pool only
        if (_isLaunchPool(pool)) {
            // Launch pool: hold at 0. Only write if currently on (idempotent, and
            // this is what heals a create-then-lock front-run once the lock lands).
            (,,,,, uint8 fp,) = IV3PoolMin(pool).slot0();
            if (fp != 0) {
                IV3PoolMin(pool).setFeeProtocol(0, 0);
                emit ForcedZero(pool);
            }
            emit Synced(pool, 0, true);
            return;
        }
        uint24 f = IV3PoolMin(pool).fee();
        if (!tierKnown[f]) revert UnknownTier();
        uint8 d = tierDefault[f];
        IV3PoolMin(pool).setFeeProtocol(d, d);
        emit Synced(pool, d, false);
    }

    /**
     * Best-effort batch (audit L-2): a single bad member (unmanaged tier,
     * uninitialized pool, fake pool) must NOT revert the whole batch and let an
     * attacker brick every keeper run. try/catch per element via an external
     * self-call; `sync` stays permissionless so the self-call is unprivileged.
     */
    function syncMany(address[] calldata pools) external {
        for (uint256 i; i < pools.length; ++i) {
            try this.sync(pools[i]) {} catch {}
        }
    }

    /**
     * Force a GENUINE launch pool to (0,0). Meant to be called by the launchpad
     * in the same tx right after `lockSingleSided` (closing the create-then-lock
     * front-run window with no gap) and by the keeper on `PositionLocked`.
     * Reverts if `pool` is not a launch pool, so it can never turn OFF the fee on
     * an ordinary pool.
     */
    function forceZero(address pool) external {
        // NOT gated by `paused`: 0 is always the safe direction, and the launchpad
        // calls this atomically in the launch tx (see ArcadeLaunchpad), so gating
        // it would let a paused manager brick every launch.
        if (!_isLaunchPool(pool)) revert NotLaunchPool();
        IV3PoolMin(pool).setFeeProtocol(0, 0);
        emit ForcedZero(pool);
    }

    /**
     * Harvest a pool's accrued protocol fees to the FIXED treasury. Permissionless
     * trigger (a keeper), non-redirectable destination: the recipient is never a
     * caller argument, so nobody can drain the fees to themselves.
     */
    function collectProtocol(address pool) external returns (uint128 amount0, uint128 amount1) {
        if (!_isCanonicalPool(pool)) revert NotAPool(); // L-1: real factory pool only
        (amount0, amount1) =
            IV3PoolMin(pool).collectProtocol(treasury, type(uint128).max, type(uint128).max);
        emit Harvested(pool, treasury, amount0, amount1);
    }

    // -------------------- Safe-only governance / escape hatches --------------------

    function setTierDefault(uint24 fee, uint8 feeProtocol) external onlyOwner {
        _setTier(fee, feeProtocol);
    }

    /** Manual override for anything the automation does not cover. */
    function setFeeProtocolRaw(address pool, uint8 fp0, uint8 fp1) external onlyOwner {
        IV3PoolMin(pool).setFeeProtocol(fp0, fp1);
        emit RawSet(pool, fp0, fp1);
    }

    /**
     * Proxy the factory `enableFeeAmount` AND set this tier's protocol-fee default
     * in the same call. `feeProtocolDefault` = 0 for a launch-only tier (stays
     * unmanaged, sync reverts UnknownTier), or 4..10 for a public tier we want
     * ordinary pools to auto-collect on. Bundling the two prevents the fee-dodge
     * where a new public tier is enabled but its default is forgotten, so pools
     * on it permanently escape the skim (audit MEDIUM-1).
     */
    function factoryEnableFeeAmount(uint24 fee, int24 tickSpacing, uint8 feeProtocolDefault)
        external
        onlyOwner
    {
        IV3Factory(factory).enableFeeAmount(fee, tickSpacing);
        _setTier(fee, feeProtocolDefault);
    }

    /** Escape hatch: hand factory ownership back to the Safe or to a new manager. */
    function transferFactoryOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IV3Factory(factory).setOwner(to);
        emit FactoryOwnershipTransferred(to);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /**
     * Two-step ownership. Because this contract holds factory ownership, a
     * fat-fingered one-step transfer would permanently strand setOwner /
     * enableFeeAmount / setFeeProtocolRaw (total loss of factory governance, audit
     * LOW-1). The new owner must accept.
     */
    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerSet(owner);
    }

    // -------------------- distinguisher --------------------

    function isLaunchPool(address pool) external view returns (bool) {
        return _isLaunchPool(pool);
    }

    /**
     * A pool is a launch pool iff one of its tokens is locked AND the locker's
     * recorded pool for that token IS this pool. Pool-keyed (not token-keyed):
     * a separate ordinary pool on a launch token at another tier is a different
     * address, so it correctly reads ORDINARY and gets skimmed. Forgery-proof:
     * `positionIdByToken` is written only by the locker's launchpad-gated lock.
     */
    function _isLaunchPool(address pool) internal view returns (bool) {
        address t0 = IV3PoolMin(pool).token0();
        address t1 = IV3PoolMin(pool).token1();
        return _lockedToThisPool(t0, pool) || _lockedToThisPool(t1, pool);
    }

    function _lockedToThisPool(address token, address pool) internal view returns (bool) {
        uint256 id = IV3LockerMin(locker).positionIdByToken(token);
        if (id == 0) return false;
        return IV3LockerMin(locker).getPosition(id).pool == pool;
    }

    /**
     * Provenance guard (audit L-1): the permissionless entrypoints must only act
     * on a REAL pool from OUR factory. Without this a fake contract implementing
     * token0/token1/fee/collectProtocol could make anyone emit spoofed
     * Synced/Harvested events and poison off-chain accounting (no fund loss, but
     * an integrity footgun). getPool is keyed by the canonical (sorted tokens,
     * fee) tuple, so it maps back uniquely to `pool`.
     */
    function _isCanonicalPool(address pool) internal view returns (bool) {
        return
            IV3Factory(factory).getPool(
                IV3PoolMin(pool).token0(), IV3PoolMin(pool).token1(), IV3PoolMin(pool).fee()
            ) == pool;
    }

    // -------------------- internal --------------------

    function _setTier(uint24 fee, uint8 v) internal {
        if (v != 0 && (v < 4 || v > 10)) revert BadValue();
        tierDefault[fee] = v;
        tierKnown[fee] = v != 0; // v == 0 unmanages the tier
        emit TierDefaultSet(fee, v);
    }
}
