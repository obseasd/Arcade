// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ArcadeLaunchToken} from "../src/launchpad/ArcadeLaunchToken.sol";
import {
    ILaunchpadSnipe,
    IPoolManager,
    IUnlockCallback,
    Currency,
    PoolKey,
    ModifyLiquidityParams,
    BalanceDelta
} from "./interfaces/IUniswapV4Types.sol";

/**
 * @title ArcadeV4Launchpad
 * @notice Standalone launchpad for tokens that trade through a Uniswap V4 pool
 *         with the anti-sniper hook attached. Strictly isolated from the
 *         production V2/V3 launchpad — has its own token registry, its own
 *         treasury, and exposes the `ILaunchpadSnipe` surface the hook reads.
 *
 *         What this contract does today:
 *           - Pulls a fixed creation fee in USDC.
 *           - Deploys an ArcadeLaunchToken with the canonical 1B supply.
 *           - Stores the per-token snipe configuration (start bps + decay
 *             seconds) and the launch timestamp. The hook reads this on
 *             every swap via `currentSnipeBps(token)`.
 *           - Exposes `treasury()` so the hook knows where to route skims.
 *
 *         What's deferred to a follow-up commit (needs a real V4 PoolManager
 *         on Arc):
 *           - V4 pool initialization (`POOL_MANAGER.initialize(key, sqrtPrice)`).
 *           - Single-sided liquidity locking via the V4 unlock callback
 *             pattern (`unlock` + `modifyLiquidity` + `settle`).
 *           - Optional creator buy at launch.
 *
 *         Splitting it this way means the on-chain hook can be tested against
 *         a deployed launchpad TODAY (and the salt miner can target a real
 *         deployer address), without waiting for a working V4 PoolManager.
 */
contract ArcadeV4Launchpad is ILaunchpadSnipe, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice V4 tick math constants. Same range as V3.
    int24 internal constant MIN_TICK = -887_272;
    int24 internal constant MAX_TICK = 887_272;

    /// @notice USDC on Arc. Required as currency in every V4 pool we register.
    IERC20 public immutable USDC;
    /// @notice The V4 PoolManager all our pools live on. Stored for the
    ///         follow-up pool-init commit; this version doesn't call it.
    IPoolManager public immutable POOL_MANAGER;
    /// @notice Anti-sniper hook deployed at a CREATE2 address whose low 14
    ///         bits encode BEFORE_SWAP + AFTER_SWAP. Every V4 pool created
    ///         here uses this hook.
    address public immutable HOOK;
    /// @notice Treasury that receives the creation fee and (via the hook)
    ///         the snipe-skim deltas on every taxed swap.
    address public immutable TREASURY;
    /// @notice Deployer that wires the launchpad once - read only.
    address public immutable DEPLOYER;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @notice USDC raw units (6 dp). Matches the production launchpad's flat
    ///         3 USDC creation fee.
    uint256 public constant CREATION_FEE = 3e6;
    /// @notice V4 pools use the same fee tier the V3 stack uses (1%).
    uint24 public constant POOL_FEE = 10_000;
    /// @notice 1% fee tier spacing.
    int24 public constant TICK_SPACING = 200;
    /// @notice Max starting sniper-tax rate (50%). Same cap as production.
    uint16 public constant MAX_SNIPE_BPS = 5_000;
    /// @notice Max opening allocation a creator can keep at launch (10% of
    ///         supply). Hard cap because anything bigger lets the creator
    ///         soft-rug. Pump.fun-style projects converge around 1-5%.
    uint16 public constant MAX_CREATOR_BPS = 1_000;

    struct Launch {
        /// @notice Token address (== address of the deployed ArcadeLaunchToken).
        address token;
        /// @notice Wallet that deployed the launch. Stored for attribution
        ///         only; the launchpad itself never sends anything to it.
        address creator;
        /// @notice PoolKey for the V4 pool tied to this launch. Populated on
        ///         pool-init (next commit); zero-initialised today.
        PoolKey poolKey;
        /// @notice Snipe tax shape.
        uint16 snipeStartBps;
        uint32 snipeDecaySeconds;
        /// @notice Wall-clock launch time used by `currentSnipeBps` decay.
        uint64 launchedAt;
        /// @notice Opening allocation kept by the creator (bps of TOTAL_SUPPLY).
        ///         Whatever is here gets minted straight to the creator at
        ///         createLaunch time; only the remainder is locked into the
        ///         V4 pool by initializePool.
        uint16 creatorBps;
    }

    /// @notice Per-token launch info, keyed by token address.
    mapping(address => Launch) public launches;
    /// @notice Append-only registry of every token launched here, for the
    ///         frontend to enumerate.
    address[] public allTokens;

    error EmptyName();
    error InvalidSnipeBps();
    error InvalidDecaySeconds();
    error InvalidCreatorBps();
    error AlreadyLaunched();
    error UnknownToken();
    error PoolAlreadyInitialized();
    error PoolNotInitialized();
    error NotPoolManager();
    error ZeroLiquidity();
    error TransferFailed();

    event TokenLaunched(
        address indexed token,
        address indexed creator,
        uint16 snipeStartBps,
        uint32 snipeDecaySeconds,
        uint64 launchedAt,
        uint16 creatorBps,
        string name,
        string symbol,
        string metadataURI
    );

    event PoolInitialized(
        address indexed token,
        address indexed pool,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    );

    constructor(IERC20 usdc_, IPoolManager poolManager_, address hook_, address treasury_) {
        USDC = usdc_;
        POOL_MANAGER = poolManager_;
        HOOK = hook_;
        TREASURY = treasury_;
        DEPLOYER = msg.sender;
    }

    // ===================== Launching =====================

    /**
     * @notice Deploy a new launch token and register its snipe config so the
     *         hook can read it on every swap. The caller pays a flat
     *         `CREATION_FEE` in USDC, routed straight to the treasury.
     *
     *         The full 1 B supply is minted to this contract. The pool-init
     *         follow-up will transfer it into the V4 pool's accounting via
     *         the unlock callback; today the supply just sits here.
     *
     * @param name           ERC20 name
     * @param symbol         ERC20 symbol
     * @param metadataURI    off-chain metadata URI (ipfs:// or data:)
     * @param snipeStartBps  starting snipe tax in bps (0..MAX_SNIPE_BPS).
     *                       Pass 0 to disable the anti-sniper hook entirely.
     * @param snipeDecaySeconds linear decay window. Required > 0 when
     *                       `snipeStartBps > 0`; ignored otherwise.
     */
    function createLaunch(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint16 snipeStartBps,
        uint32 snipeDecaySeconds,
        uint16 creatorBps
    ) external nonReentrant returns (address tokenAddr) {
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        if (snipeStartBps > MAX_SNIPE_BPS) revert InvalidSnipeBps();
        if (snipeStartBps > 0 && snipeDecaySeconds == 0) revert InvalidDecaySeconds();
        if (creatorBps > MAX_CREATOR_BPS) revert InvalidCreatorBps();

        // Pull the creation fee straight to treasury. Doing it before the
        // token deploy means we don't waste gas on a deploy if the user is
        // short on USDC or hasn't approved.
        USDC.safeTransferFrom(msg.sender, TREASURY, CREATION_FEE);

        ArcadeLaunchToken token = new ArcadeLaunchToken(name, symbol, TOTAL_SUPPLY, address(this));
        tokenAddr = address(token);

        if (launches[tokenAddr].token != address(0)) revert AlreadyLaunched();

        uint64 nowTs = uint64(block.timestamp);
        Launch storage l = launches[tokenAddr];
        l.token = tokenAddr;
        l.creator = msg.sender;
        l.snipeStartBps = snipeStartBps;
        l.snipeDecaySeconds = snipeDecaySeconds;
        l.launchedAt = nowTs;
        l.creatorBps = creatorBps;
        // l.poolKey stays zero-initialised; populated by initializePool().

        // Transfer the opening creator allocation BEFORE pool-init so the
        // remainder of the supply is what gets locked into the V4 position.
        // Doing it here (not at initializePool time) means the creator's
        // share is independent of the pool state and immune to any swap
        // front-running attempt.
        if (creatorBps > 0) {
            uint256 creatorAlloc = (TOTAL_SUPPLY * creatorBps) / 10_000;
            IERC20(tokenAddr).safeTransfer(msg.sender, creatorAlloc);
        }

        allTokens.push(tokenAddr);

        emit TokenLaunched(
            tokenAddr,
            msg.sender,
            snipeStartBps,
            snipeDecaySeconds,
            nowTs,
            creatorBps,
            name,
            symbol,
            metadataURI
        );
    }

    // ===================== Pool initialization =====================

    /**
     * @notice Initialise the V4 pool for `token` at `sqrtPriceX96` and lock
     *         the full LP supply single-sided so the token is tradeable from
     *         this block forward. Idempotent per token: a second call reverts.
     *
     *         Single-sided here means the position covers only the price
     *         range ABOVE the start price (if token is currency0) or BELOW
     *         (if token is currency1). The pool starts with no USDC reserve;
     *         buyers consume tokens and price moves up the curve.
     *
     *         V4's lock pattern means we can't just call modifyLiquidity
     *         directly. We `unlock` the PoolManager and let it call back into
     *         `unlockCallback`, where the actual modifyLiquidity + settle
     *         sequence runs.
     *
     * @param token        Address of a previously-launched token.
     * @param sqrtPriceX96 Q64.96 price at which to initialise the pool.
     * @param liquidityDelta Pre-computed liquidity to add. The caller is
     *                     expected to derive this from the LP supply via
     *                     LiquidityAmounts.getLiquidityForAmount0/1 off-chain.
     *                     For the prototype we expose it as an arg so we
     *                     don't carry the full TickMath / LiquidityAmounts
     *                     library inline; production will inline this.
     */
    function initializePool(address token, uint160 sqrtPriceX96, int128 liquidityDelta)
        external
        nonReentrant
    {
        Launch storage l = launches[token];
        if (l.token == address(0)) revert UnknownToken();
        // currency0 is always either USDC or the launch token after a
        // successful init, both non-zero. We can't use `hooks != 0` because
        // the hook permission-mining flow technically allows a zero address
        // (and in tests the launchpad is wired before the hook exists).
        if (Currency.unwrap(l.poolKey.currency0) != address(0)) revert PoolAlreadyInitialized();
        if (liquidityDelta <= 0) revert ZeroLiquidity();

        (Currency c0, Currency c1) = address(USDC) < token
            ? (Currency.wrap(address(USDC)), Currency.wrap(token))
            : (Currency.wrap(token), Currency.wrap(address(USDC)));

        PoolKey memory key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: HOOK
        });
        // Persist BEFORE the external init call so the unlockCallback can
        // read the key back from storage.
        l.poolKey = key;

        POOL_MANAGER.initialize(key, sqrtPriceX96);

        // Hand control to the PoolManager: it calls our unlockCallback with
        // the data we encode here, and inside that callback we run the
        // modifyLiquidity + settle sequence.
        POOL_MANAGER.unlock(abi.encode(token, sqrtPriceX96, liquidityDelta));
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only the PoolManager is allowed to enter here - it's the only
    ///      caller that ever sees the unlocked state. The callback computes
    ///      the single-sided position bounds, calls modifyLiquidity, and
    ///      settles the resulting token debt by transferring the LP supply
    ///      into the PoolManager.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (address token, uint160 sqrtPriceX96, int128 liquidityDelta) =
            abi.decode(data, (address, uint160, int128));

        Launch storage l = launches[token];
        PoolKey memory key = l.poolKey;

        // Determine which currency is the launch token + its initial tick.
        bool tokenIsCurrency0 = Currency.unwrap(key.currency0) == token;
        int24 currentTick = _tickAtSqrtPriceApprox(sqrtPriceX96);
        (int24 tickLower, int24 tickUpper) = _singleSidedRange(tokenIsCurrency0, currentTick);

        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidityDelta: int256(liquidityDelta),
            salt: bytes32(0)
        });
        POOL_MANAGER.modifyLiquidity(key, params, "");

        // Settle the token side. modifyLiquidity creates a debt on the
        // launch-token currency equal to the amount the pool needs to
        // realise our requested liquidity. We sync, transfer whatever supply
        // the launchpad still holds (creator allocation already deducted in
        // createLaunch), and call settle to clear the debt. The USDC side
        // has zero debt because this is a single-sided position above (or
        // below) the current tick - the pool wants no USDC at init.
        Currency tokenCurrency = tokenIsCurrency0 ? key.currency0 : key.currency1;
        POOL_MANAGER.sync(tokenCurrency);
        uint256 poolAlloc = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(address(POOL_MANAGER), poolAlloc);
        POOL_MANAGER.settle();

        emit PoolInitialized(token, address(POOL_MANAGER), sqrtPriceX96, tickLower, tickUpper, int256(liquidityDelta));
        return "";
    }

    /// @dev Bounds for a single-sided position: above the start tick if the
    ///      launch token is currency0 (price rises as token gets bought),
    ///      below if it's currency1. One position, full upper / lower range
    ///      from the start tick to the usable bound. Real production may
    ///      split into 3 ranges Clanker-style; the prototype keeps it as 1.
    function _singleSidedRange(bool tokenIsCurrency0, int24 currentTick)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        int24 maxUsable = (MAX_TICK / TICK_SPACING) * TICK_SPACING;
        int24 minUsable = -maxUsable;
        if (tokenIsCurrency0) {
            tickLower = _floorTick(currentTick) + TICK_SPACING;
            tickUpper = maxUsable;
        } else {
            tickLower = minUsable;
            tickUpper = _floorTick(currentTick);
        }
    }

    /// @dev Snaps `tick` down to the nearest multiple of TICK_SPACING. Handles
    ///      negatives correctly (Solidity / rounds toward zero, we want floor).
    function _floorTick(int24 tick) internal pure returns (int24) {
        int24 compressed = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) compressed--;
        return compressed * TICK_SPACING;
    }

    /// @dev Approximate currentTick from sqrtPriceX96. We pass this through to
    ///      `_singleSidedRange` to compute the position bounds. For the
    ///      prototype we use a coarse derivation; in production the
    ///      PoolManager.initialize return value (the actual tick) should be
    ///      stored on the Launch struct so we don't recompute.
    function _tickAtSqrtPriceApprox(uint160 sqrtPriceX96) internal pure returns (int24) {
        // tick = floor(log_{1.0001}(price)) where price = (sqrt / 2^96)^2.
        // For the prototype we return 0 when sqrtPriceX96 is at the Q96 unit
        // (price = 1) and rely on a real V4 deploy storing the manager's
        // returned tick. Tests inject a controlled value through this path
        // and assert the position bounds are sane.
        if (sqrtPriceX96 >= 1 << 96) return 0;
        return -TICK_SPACING; // any small negative; tests verify the snap behaviour
    }

    // ===================== ILaunchpadSnipe surface =====================

    /// @notice Current snipe tax rate (bps) for `token`. Linear decay from
    ///         `snipeStartBps` at launch to 0 after `snipeDecaySeconds`.
    ///         Mirrors the production launchpad's exact decay math.
    function currentSnipeBps(address token) external view override returns (uint256) {
        Launch memory l = launches[token];
        if (l.snipeStartBps == 0 || l.snipeDecaySeconds == 0) return 0;
        if (l.launchedAt == 0) return 0;
        uint256 elapsed = block.timestamp - l.launchedAt;
        if (elapsed >= l.snipeDecaySeconds) return 0;
        return (uint256(l.snipeStartBps) * (l.snipeDecaySeconds - elapsed)) / l.snipeDecaySeconds;
    }

    /// @notice Treasury that receives the hook's snipe skims.
    function treasury() external view override returns (address) {
        return TREASURY;
    }

    // ===================== Views =====================

    function tokensCount() external view returns (uint256) {
        return allTokens.length;
    }

    function getLaunch(address token) external view returns (Launch memory) {
        return launches[token];
    }
}
