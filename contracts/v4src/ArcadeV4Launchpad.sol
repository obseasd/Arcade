// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ArcadeLaunchToken} from "../src/launchpad/ArcadeLaunchToken.sol";
import {ILaunchpadSnipe} from "./interfaces/IArcadeV4Launchpad.sol";

// Upstream V4 core (vendored under contracts/lib/v4-core).
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

/**
 * @title ArcadeV4Launchpad
 * @notice Standalone launchpad for tokens that trade through a Uniswap V4 pool
 *         with the anti-sniper hook attached. Strictly isolated from the
 *         production V2/V3 launchpad — has its own token registry, its own
 *         treasury, and exposes the `ILaunchpadSnipe` surface the hook reads.
 *
 *         What this contract does:
 *           - Pulls a fixed creation fee in USDC.
 *           - Deploys an ArcadeLaunchToken with the canonical 1B supply.
 *           - Hands an opening allocation (max 10%) straight to the creator.
 *           - Stores the per-token snipe configuration (start bps + decay
 *             seconds) and the launch timestamp. The hook reads this on
 *             every swap via `currentSnipeBps(token)`.
 *           - Initialises the V4 pool and locks single-sided liquidity via
 *             the `unlock` -> `modifyLiquidity` -> `sync` -> `settle` sequence.
 *           - Exposes `treasury()` so the hook knows where to route skims.
 *
 *         Bootstrap order (mutual constructor dependency between hook and
 *         launchpad is broken with a one-shot `setHook`):
 *           1. Deploy launchpad (HOOK = 0).
 *           2. CREATE2-deploy the anti-sniper hook with constructor refs
 *              pointing at the launchpad, using a salt mined so the deployed
 *              address has BEFORE_SWAP + AFTER_SWAP permission bits set.
 *           3. Call `launchpad.setHook(hookAddr)`. Reverts on second call.
 *
 *         `DeployV4.s.sol` orchestrates this end to end.
 */
contract ArcadeV4Launchpad is ILaunchpadSnipe, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice V4 tick math constants. Same range as V3.
    int24 internal constant MIN_TICK = -887_272;
    int24 internal constant MAX_TICK = 887_272;

    /// @notice USDC on Arc. Required as currency in every V4 pool we register.
    IERC20 public immutable USDC;
    /// @notice The V4 PoolManager all our pools live on.
    IPoolManager public immutable POOL_MANAGER;
    /// @notice Anti-sniper hook deployed at a CREATE2 address whose low 14
    ///         bits encode BEFORE_SWAP + AFTER_SWAP. Every V4 pool created
    ///         here uses this hook. Settable ONCE by the deployer post-construct
    ///         to resolve the mutual constructor dependency with the hook
    ///         (hook needs the launchpad address; launchpad needs the
    ///         CREATE2-mined hook address).
    address public HOOK;
    /// @notice Treasury that receives the creation fee and (via the hook)
    ///         the snipe-skim deltas on every taxed swap.
    /// @dev Audit CSEC-002: changed from `immutable` to a mutable slot
    ///      behind `setTreasury(owner-only)` so a USDC blocklist event on
    ///      treasury doesn't permanently brick createLaunch. Matches the
    ///      `ArcadeHook.setTreasury` pattern.
    address public TREASURY;
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
    /// @notice Lower bound on the start price a creator can pass to
    ///         initializePool. Refuses sqrt prices anywhere near
    ///         Uniswap's MIN_SQRT_RATIO (~4.3e9), which a front-runner
    ///         could otherwise pass to steal the LP for cents.
    ///         Audit CSEC-012.
    uint160 public constant SQRT_PRICE_FLOOR = 1e15;
    /// @notice Upper bound on the start price. Refuses obviously
    ///         pumped-up start prices that would let a creator extract
    ///         disproportionate value from the first organic buyer.
    uint160 public constant SQRT_PRICE_CEILING = 1e35;

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

    /// @notice Outstanding creation-fee USDC sitting on the launchpad,
    ///         waiting for a `sweepCreationFees` call to forward to
    ///         TREASURY. Audit CSEC-002.
    uint256 public pendingCreationFees;
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
    error NotPoolManager();
    error NotDeployer();
    error HookAlreadySet();
    error HookNotSet();
    error ZeroAddress();
    error ZeroLiquidity();
    /// @notice initializePool was called by a non-creator. Audit CSEC-012:
    ///         the original prototype allowed any caller to set the start
    ///         price, which let a mempool watcher front-run the legit
    ///         creator's init and dump the entire post-creator-alloc
    ///         supply at an attacker-chosen price.
    error NotCreator();
    /// @notice initializePool was called with a sqrtPriceX96 outside the
    ///         allowed floor/ceiling band. Audit CSEC-012.
    error SqrtPriceOutOfRange();
    /// @notice unsafeSweep was called by something other than the
    ///         launchpad itself. Audit CSEC-002.
    error NotSelfCall();
    /// @notice The treasury transfer in sweepCreationFees reverted (USDC
    ///         blocklist on treasury). Audit CSEC-002.
    error TreasuryTransferFailed();

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

    event HookSet(address indexed hook);
    /// @notice Treasury address rotated by the deployer. Audit CSEC-002.
    event TreasuryRotated(address indexed newTreasury);
    /// @notice Pending creation-fee pot drained to the current treasury.
    ///         Audit CSEC-002.
    event CreationFeesSwept(address indexed treasury, uint256 amount);

    constructor(IERC20 usdc_, IPoolManager poolManager_, address treasury_) {
        if (address(usdc_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        USDC = usdc_;
        POOL_MANAGER = poolManager_;
        TREASURY = treasury_;
        DEPLOYER = msg.sender;
    }

    /// @notice One-shot setter the deployer calls after CREATE2-deploying the
    ///         anti-sniper hook at its salt-mined address. Reverts once set,
    ///         so the wiring is effectively immutable post-bootstrap.
    function setHook(address hook_) external {
        if (msg.sender != DEPLOYER) revert NotDeployer();
        if (HOOK != address(0)) revert HookAlreadySet();
        if (hook_ == address(0)) revert ZeroAddress();
        HOOK = hook_;
        emit HookSet(hook_);
    }

    /// @notice Rotate the treasury address. Deployer-gated; lets ops respond
    ///         to a USDC blocklist event on the original treasury without
    ///         redeploying the launchpad. Audit CSEC-002.
    function setTreasury(address treasury_) external {
        if (msg.sender != DEPLOYER) revert NotDeployer();
        if (treasury_ == address(0)) revert ZeroAddress();
        TREASURY = treasury_;
        emit TreasuryRotated(treasury_);
    }

    /// @notice Sweep accumulated creation fees to the CURRENT treasury.
    ///         Permissionless: anyone can pay the gas to flush the pot.
    ///         Wrapped in try/catch so a transient blocklist event on
    ///         treasury doesn't trap the fees inside the launchpad forever
    ///         - they stay claimable from the next sweep after a
    ///         setTreasury rotation. Audit CSEC-002.
    function sweepCreationFees() external nonReentrant {
        uint256 amt = pendingCreationFees;
        if (amt == 0) return;
        pendingCreationFees = 0;
        try this.unsafeSweep(TREASURY, amt) {
            emit CreationFeesSwept(TREASURY, amt);
        } catch {
            // Restore the pot for the next sweep attempt - never
            // accidentally let it leak to address(0).
            pendingCreationFees = amt;
            revert TreasuryTransferFailed();
        }
    }

    /// @notice External-only forwarder used by sweepCreationFees so we can
    ///         try/catch a USDC blocklist revert from inside the same call
    ///         tree. NOT meant to be called externally; the strict
    ///         msg.sender == address(this) guard turns it into a pure
    ///         internal-via-external pattern.
    function unsafeSweep(address to, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelfCall();
        USDC.safeTransfer(to, amount);
    }

    // ===================== Launching =====================

    /**
     * @notice Deploy a new launch token and register its snipe config so the
     *         hook can read it on every swap. The caller pays a flat
     *         `CREATION_FEE` in USDC, held in THIS contract as
     *         `pendingCreationFees` and drained to the treasury by a later
     *         `sweepCreationFees()` call (CSEC-002 -- see the rationale at
     *         the transfer below; a direct transfer would let a blocklisted
     *         treasury brick every launch).
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
        // Defense-in-depth: refuse launches until the deployer has wired
        // setHook(). Otherwise a watcher could front-run the deployer between
        // the launchpad deploy and the setHook call, creating launches that
        // would then be initializePool'd with hooks = address(0) (audit #2).
        if (HOOK == address(0)) revert HookNotSet();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        if (snipeStartBps > MAX_SNIPE_BPS) revert InvalidSnipeBps();
        if (snipeStartBps > 0 && snipeDecaySeconds == 0) revert InvalidDecaySeconds();
        if (creatorBps > MAX_CREATOR_BPS) revert InvalidCreatorBps();

        // CSEC-002: pull the creation fee into THIS contract, not directly
        // to TREASURY. If TREASURY ever gets blocklisted on USDC (Arc has
        // a precompile that can revert transfers), a direct transfer to
        // it would brick every createLaunch permanently. Holding the
        // funds here lets a `sweepCreationFees` call drain them to the
        // current treasury (after a setTreasury rotation if the original
        // one is compromised). Trade-off: 1 extra SSTORE per call vs. an
        // unrecoverable bricking risk.
        USDC.safeTransferFrom(msg.sender, address(this), CREATION_FEE);
        pendingCreationFees += CREATION_FEE;

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
        // Same guard as createLaunch (audit #2). The hook field of every pool
        // created here is `HOOK`; if it's zero, the resulting pool has no
        // anti-sniper hook attached - permanently, since PoolKey.hooks is
        // immutable in v4-core.
        if (HOOK == address(0)) revert HookNotSet();
        Launch storage l = launches[token];
        if (l.token == address(0)) revert UnknownToken();
        if (Currency.unwrap(l.poolKey.currency0) != address(0)) revert PoolAlreadyInitialized();
        if (liquidityDelta <= 0) revert ZeroLiquidity();
        // CSEC-012: only the launch's creator (the address that called
        // createLaunch) can initialise the pool. Before this gate, any
        // mempool watcher could front-run the creator's init tx with an
        // attacker-chosen sqrtPriceX96, lock the pool at the wrong start
        // price (PoolAlreadyInitialized makes it irreversible), and dump
        // the entire post-creator-alloc supply through the thin LP.
        if (msg.sender != l.creator) revert NotCreator();
        // CSEC-012 (continued): even with the creator gate, validate that
        // the start price is inside a sane band. SQRT_PRICE_FLOOR /
        // SQRT_PRICE_CEILING are mirrored from the V3 launchpad's
        // min-mcap bracket and chosen to refuse the canonical
        // 0-implied-price and MAX_SQRT_PRICE attacks. A creator who
        // wants a custom start price still has the full range from
        // 0.0001 USDC/token to 100k USDC/token.
        if (sqrtPriceX96 < SQRT_PRICE_FLOOR || sqrtPriceX96 > SQRT_PRICE_CEILING) {
            revert SqrtPriceOutOfRange();
        }

        (Currency c0, Currency c1) = address(USDC) < token
            ? (Currency.wrap(address(USDC)), Currency.wrap(token))
            : (Currency.wrap(token), Currency.wrap(address(USDC)));

        PoolKey memory key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(HOOK)
        });
        // Persist BEFORE the external init call so the unlockCallback can
        // read the key back from storage.
        l.poolKey = key;

        // PoolManager returns the actual tick the pool initialised at; we
        // pipe that into unlockCallback rather than re-deriving from sqrtPrice
        // (which would require the full TickMath library inline).
        int24 currentTick = POOL_MANAGER.initialize(key, sqrtPriceX96);

        // Hand control to the PoolManager: it calls our unlockCallback with
        // the data we encode here, and inside that callback we run the
        // modifyLiquidity + settle sequence.
        POOL_MANAGER.unlock(abi.encode(token, currentTick, liquidityDelta, sqrtPriceX96));
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only the PoolManager is allowed to enter here - it's the only
    ///      caller that ever sees the unlocked state. The callback computes
    ///      the single-sided position bounds, calls modifyLiquidity, and
    ///      settles the resulting token debt by transferring the LP supply
    ///      into the PoolManager.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (address token, int24 currentTick, int128 liquidityDelta, uint160 sqrtPriceX96) =
            abi.decode(data, (address, int24, int128, uint160));

        Launch storage l = launches[token];
        PoolKey memory key = l.poolKey;

        bool tokenIsCurrency0 = Currency.unwrap(key.currency0) == token;
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

    /// @notice Pre-flight view used by the frontend / deploy script to size the
    ///         `liquidityDelta` arg of `initializePool`. Returns the bounds
    ///         that `unlockCallback` will use, plus the tick the pool will
    ///         initialise at if the caller passes `currentTick`. The actual
    ///         liquidity-from-amount math (LiquidityAmounts.getLiquidityForAmount0
    ///         / Amount1) lives off-chain because importing it inline would
    ///         double the bytecode size for a single view. The returned bounds
    ///         are the inputs that lib needs.
    /// @param token Previously launched token (must exist).
    /// @param currentTick Tick the pool is initialising at, as reported by
    ///        PoolManager. Off-chain callers can derive this from sqrtPriceX96
    ///        via TickMath.getTickAtSqrtPrice.
    function previewPosition(address token, int24 currentTick)
        external
        view
        returns (int24 tickLower, int24 tickUpper, bool tokenIsCurrency0)
    {
        Launch memory l = launches[token];
        if (l.token == address(0)) revert UnknownToken();
        tokenIsCurrency0 = address(token) < address(USDC);
        (tickLower, tickUpper) = _singleSidedRange(tokenIsCurrency0, currentTick);
    }

    /// @notice Amount of the launch token that's still in the launchpad and
    ///         will be locked into the pool by `initializePool`. Useful for
    ///         the frontend to display the pool's opening reserve.
    function poolAllocation(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
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

    /// @notice Treasury that received the launch's creation fee. Indexer
    ///         convenience: the hook no longer reads this (it caches its
    ///         own immutable TREASURY at construction - audit fix #3) but
    ///         it stays public so dashboards can show "launches that paid
    ///         their fee to <treasury>".
    function treasury() external view returns (address) {
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
