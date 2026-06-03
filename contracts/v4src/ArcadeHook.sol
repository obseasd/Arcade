// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ArcadeLaunchToken} from "../src/launchpad/ArcadeLaunchToken.sol";
import {ArcadeV4Curve} from "./libraries/ArcadeV4Curve.sol";
import {ILaunchpadSnipe} from "./interfaces/IArcadeV4Launchpad.sol";

// v4-core upstream.
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

/**
 * @title ArcadeHook
 * @notice Unified Uniswap V4 hook for the Arcade launchpad. Subsumes the V2
 *         stack (Factory + Pair + Router + Launchpad + V3 Locker) into a
 *         single hook bound to one canonical PoolManager on Arc.
 *
 *         This is the foundation pass (Phase 2 Round 2 per `v4-migration-scoping.md`).
 *         Implements:
 *           - Frozen state layout (CurveState, FeeOwner, PositionInfo).
 *           - Frozen permission bitmap (0x3EEC).
 *           - Ownable2Step + Pausable + ReentrancyGuard plumbing.
 *           - Constructor with immutable wiring.
 *           - createLaunch: registers a token + deploys ArcadeLaunchToken,
 *             pulls creation fee in USDC, configures fee owners + snipe.
 *           - All 14 hook callbacks. The 4 unused (after-remove, both donates,
 *             after-remove-returns-delta) revert HookNotImplemented. The 10
 *             implemented ones return safe defaults (ZERO_DELTA + selector).
 *
 *         Actual curve math, graduation, royalty splits, and locked-LP minting
 *         are added in Rounds 3-5. The intent of this pass is to ship a
 *         compilable, testable, address-mineable contract that the deploy
 *         script can stand up on testnet today and that subsequent rounds
 *         can incrementally enrich without changing the surface.
 *
 * @dev    Hook permission flags MUST match the address bits CREATE2-mined by
 *         `v4script/MineHookSalt.s.sol`. Set in `getHookPermissions()`:
 *           bit 13: BEFORE_INITIALIZE_FLAG
 *           bit 12: AFTER_INITIALIZE_FLAG
 *           bit 11: BEFORE_ADD_LIQUIDITY_FLAG
 *           bit 10: AFTER_ADD_LIQUIDITY_FLAG
 *           bit 9:  BEFORE_REMOVE_LIQUIDITY_FLAG
 *           bit 7:  BEFORE_SWAP_FLAG
 *           bit 6:  AFTER_SWAP_FLAG
 *           bit 3:  BEFORE_SWAP_RETURNS_DELTA_FLAG
 *           bit 2:  AFTER_SWAP_RETURNS_DELTA_FLAG
 *           bit 1:  AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG
 *         => bitmap 0x3ECE (10 bits set; V4_HOOK_SPEC.md Section 3 has a
 *           typo "0x3EEC" — the correct value matching that table is 0x3ECE).
 *
 *         The hook does NOT inherit BaseHook; it implements IHooks directly
 *         so the permission check happens entirely via address bit pattern
 *         (no validateHookAddress call), letting tests use deployCodeTo to
 *         place the hook at a chosen address with the right bits.
 */
contract ArcadeHook is IHooks, Ownable2Step, Pausable, ReentrancyGuard, ILaunchpadSnipe {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    // -------------------------------------------------------------------
    // Launch mode (matches V2 ArcadeLaunchpad.LaunchMode)
    // -------------------------------------------------------------------

    enum LaunchMode {
        PUMP, // 0
        CLANKER, // 1
        CLANKER_V3 // 2
    }

    // -------------------------------------------------------------------
    // State structs (frozen per V4_HOOK_SPEC.md Section 2)
    // -------------------------------------------------------------------

    struct CurveState {
        uint128 virtualUsdcReserve; // 5_000e6 at init, immutable per pool
        uint128 realUsdcReserve; // climbs to 20_000e6 at graduation
        uint128 tokensSold; // climbs to CURVE_SUPPLY
        uint8 mode; // LaunchMode cast
        uint8 status; // 0=Curving, 1=GraduationStarted, 2=Graduated
        address creator;
        address creator2; // optional secondary recipient
        uint16 creator2Bps; // share of creator fee that routes to creator2
    }

    struct FeeOwner {
        address creator;
        address creator2;
        uint16 creator2Bps;
        address twitterEscrow; // zero = direct transfer; non-zero = creditSlot
        uint8 slotIndex; // 0..3, used when twitterEscrow != address(0)
    }

    struct PositionInfo {
        address owner; // for accounting only; LOCKED_VAULT holds 6909 receipt
        uint128 liquidity;
        bool locked;
    }

    struct SnipeConfig {
        uint16 startBps; // 0 means anti-sniper disabled for this token
        uint32 decaySeconds; // linear decay window
        uint64 launchedAt; // block.timestamp at launch
    }

    enum Status {
        Curving, // 0
        GraduationStarted, // 1
        Graduated // 2
    }

    // -------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------

    IPoolManager public immutable POOL_MANAGER;
    /// @notice USDC on the deployment chain. Pool currencies are validated
    ///         in beforeInitialize: exactly one of (currency0, currency1)
    ///         MUST equal USDC.
    Currency public immutable USDC;
    /// @notice Recipient of locked LP claim tokens. Owns ERC-6909 receipts
    ///         minted in afterAddLiquidity for graduation-seed and
    ///         CLANKER_V3-init positions. Has no transfer surface, so the
    ///         receipts are effectively burned.
    address public immutable LOCKED_VAULT;
    /// @notice Treasury that receives creation fees + post-graduation royalty
    ///         + anti-sniper skims. Owner-mutable post-bootstrap (see setTreasury).
    address public TREASURY;
    /// @notice TwitterEscrowV3 target. Owner-mutable; address(0) disables the
    ///         creator-fee escrow path entirely.
    address public twitterEscrow;

    // -------------------------------------------------------------------
    // Constants (curve math lives in ArcadeV4Curve; these are V4-specific)
    // -------------------------------------------------------------------

    /// @notice Curve trade fee, 1%. Encoded as a dynamic-fee override that
    ///         `beforeSwap` returns as the third tuple element while the pool
    ///         is in Curving status.
    uint24 internal constant TRADE_FEE_BPS = 100;

    /// @notice Total post-graduation royalty applied to the USDC leg of every
    ///         swap routed through the pool. Split per mode in afterSwap.
    uint24 internal constant POST_GRAD_ROYALTY_BPS = 30; // 0.30%

    /// @notice Mode-specific creator share of the post-graduation royalty.
    ///         Indexed by `LaunchMode`.
    uint16[3] internal MODE_CREATOR_BPS = [5_000, 7_000, 8_000];

    /// @notice Max allowed anti-sniper starting tax (50%). Decays linearly to 0.
    uint16 internal constant MAX_SNIPE_START_BPS = 5_000;

    /// @notice Flat USDC creation fee charged at createLaunch (6 dp).
    uint256 internal constant CREATION_FEE = 3e6; // 3 USDC

    // -------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------

    mapping(PoolId => CurveState) public curveStates;
    mapping(PoolId => FeeOwner) public feeOwners;
    /// @notice positionKey => info. Key = keccak(PoolId, tickLower, tickUpper, salt).
    mapping(bytes32 => PositionInfo) public positions;
    /// @notice Launch token => true once createLaunch registers it. Cleared
    ///         intentionally never; a token is registered for life.
    mapping(address => bool) public registeredLaunches;
    /// @notice Anti-sniper config per launch token.
    mapping(address => SnipeConfig) public snipeConfigs;
    /// @notice Launch token => PoolId so `currentSnipeBps` callers (the hook
    ///         itself + indexers) can look up the curve state from a token addr.
    mapping(address => PoolId) public poolIdOf;

    /// @notice Append-only registry for indexer enumeration.
    address[] public allTokens;

    // -------------------------------------------------------------------
    // Errors (frozen per V4_HOOK_SPEC.md Section 13)
    // -------------------------------------------------------------------

    error NotPoolManager();
    error OnlyLaunchpad(); // beforeInitialize sender check
    error LaunchNotRegistered();
    error NotUsdcPair();
    error GraduationInProgress();
    error LockedPosition();
    error LiquidityNotPermitted();
    error HookNotImplemented();
    error ZeroAmount();
    error InvalidMode();
    error InvalidFeeOwner();
    error InvariantBroken();
    error ZeroAddress();
    error EmptyName();
    error InvalidSnipeBps();
    error InvalidDecaySeconds();
    error AlreadyLaunched();

    // -------------------------------------------------------------------
    // Events (frozen per V4_HOOK_SPEC.md Section 14)
    // -------------------------------------------------------------------

    event LaunchCreated(PoolId indexed poolId, address indexed token, address creator, uint8 mode);
    event CurveBuy(PoolId indexed poolId, address indexed buyer, uint256 grossUsdcIn, uint256 tokensOut);
    event CurveSell(PoolId indexed poolId, address indexed seller, uint256 tokensIn, uint256 usdcOut);
    event Graduated(PoolId indexed poolId, uint256 finalUsdcReserve, uint256 tokensInLP);
    event RoyaltyPaid(PoolId indexed poolId, address indexed creator, uint256 creatorAmount, uint256 treasuryAmount);
    event AntiSnipeApplied(PoolId indexed poolId, address indexed sniper, uint256 amount, uint16 bps);
    event EscrowCreditFailed(uint256 indexed positionId, uint8 slot, uint256 amount);
    event PositionLocked(bytes32 indexed positionKey, address indexed owner, uint128 liquidity);
    event FeeHarvested(bytes32 indexed positionKey, uint256 amount0, uint256 amount1);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event TwitterEscrowUpdated(address indexed oldEscrow, address indexed newEscrow);
    event SnipeConfigured(address indexed token, uint16 startBps, uint32 decaySeconds);
    event TokenLaunched(
        address indexed token,
        address indexed creator,
        uint8 mode,
        string name,
        string symbol,
        string metadataURI
    );

    // -------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------

    modifier onlyPoolManager() {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        _;
    }

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    constructor(
        IPoolManager poolManager_,
        Currency usdc_,
        address lockedVault_,
        address treasury_,
        address twitterEscrow_,
        address owner_
    ) Ownable(owner_) {
        if (address(poolManager_) == address(0)) revert ZeroAddress();
        if (Currency.unwrap(usdc_) == address(0)) revert ZeroAddress();
        if (lockedVault_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        // twitterEscrow_ allowed to be zero; disables the escrow path until
        // an admin wires it via setTwitterEscrow. Keeps mainnet bootstrap from
        // requiring all peripheral contracts to be live on day 1.

        POOL_MANAGER = poolManager_;
        USDC = usdc_;
        LOCKED_VAULT = lockedVault_;
        TREASURY = treasury_;
        twitterEscrow = twitterEscrow_;
    }

    // -------------------------------------------------------------------
    // Hook permissions (frozen)
    // -------------------------------------------------------------------

    /// @notice Returns the 14-bit hook permission flag bitmap. The deployed
    ///         address MUST encode exactly these bits in its low 14 bits.
    /// @dev Total: 10 bits set. Hex: 0x3ECE = 16078.
    function getHookPermissions() public pure returns (uint160) {
        return Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
    }

    // -------------------------------------------------------------------
    // Launch lifecycle
    // -------------------------------------------------------------------

    /**
     * @notice Register a new launch, deploy its ERC20, AND initialise the V4
     *         pool atomically. The hook holds the full token supply during
     *         curving and trades it against the bonding curve in beforeSwap.
     *         At graduation (Round 4), the unsold remainder becomes the LP
     *         seed for a canonical AMM position.
     *
     *         Pulls the flat creation fee in USDC straight to treasury before
     *         anything else, so a token never lands on-chain unless the
     *         caller actually paid.
     *
     * @param name             ERC20 name
     * @param symbol           ERC20 symbol
     * @param metadataURI      off-chain metadata URI (ipfs:// or data:)
     * @param mode             0=PUMP, 1=CLANKER, 2=CLANKER_V3
     * @param creator2         optional secondary fee recipient (CLANKER only).
     *                          Pass address(0) to disable.
     * @param creator2Bps      share of creator fee routed to creator2 (bps).
     *                          Ignored when creator2 == address(0).
     * @param snipeStartBps    starting anti-sniper tax (0..MAX_SNIPE_START_BPS).
     *                          Pass 0 to disable anti-sniper for this token.
     * @param snipeDecaySeconds linear decay window for the anti-sniper tax.
     *                          Required > 0 when snipeStartBps > 0.
     */
    function createLaunch(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint8 mode,
        address creator2,
        uint16 creator2Bps,
        uint16 snipeStartBps,
        uint32 snipeDecaySeconds
    ) external nonReentrant whenNotPaused returns (address tokenAddr, PoolId poolId) {
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        if (mode > uint8(LaunchMode.CLANKER_V3)) revert InvalidMode();
        if (creator2Bps > 10_000) revert InvalidFeeOwner();
        if (snipeStartBps > MAX_SNIPE_START_BPS) revert InvalidSnipeBps();
        if (snipeStartBps > 0 && snipeDecaySeconds == 0) revert InvalidDecaySeconds();

        // Pull the creation fee first. If the user is short on USDC or hasn't
        // approved we revert before deploying a token nobody can use.
        IERC20(Currency.unwrap(USDC)).safeTransferFrom(msg.sender, TREASURY, CREATION_FEE);

        // Deploy the launch token with TOTAL_SUPPLY minted to the hook. The
        // hook holds the supply during curving and ships tokens to buyers in
        // beforeSwap. At graduation the remainder seeds the post-curve AMM.
        ArcadeLaunchToken token = new ArcadeLaunchToken(name, symbol, ArcadeV4Curve.TOTAL_SUPPLY, address(this));
        tokenAddr = address(token);
        if (registeredLaunches[tokenAddr]) revert AlreadyLaunched();

        registeredLaunches[tokenAddr] = true;
        allTokens.push(tokenAddr);

        // Build the canonical PoolKey for this launch and persist EVERYTHING
        // beforeInitialize / afterInitialize / beforeSwap will need, BEFORE
        // calling pm.initialize. This way the lifecycle callbacks find a
        // fully-formed state and never have to defer.
        PoolKey memory key = _buildPoolKey(tokenAddr);
        poolId = key.toId();
        poolIdOf[tokenAddr] = poolId;

        curveStates[poolId] = CurveState({
            virtualUsdcReserve: uint128(ArcadeV4Curve.VIRTUAL_USDC_RESERVE),
            realUsdcReserve: 0,
            tokensSold: 0,
            mode: mode,
            status: uint8(Status.Curving),
            creator: msg.sender,
            creator2: creator2,
            creator2Bps: creator2Bps
        });

        feeOwners[poolId] = FeeOwner({
            creator: msg.sender,
            creator2: creator2,
            creator2Bps: creator2Bps,
            twitterEscrow: address(0), // wired separately when escrow is enabled per-launch
            slotIndex: 0
        });

        // Snipe config keyed by token addr so currentSnipeBps reads cheaply
        // from anti-sniper checks in beforeSwap / afterSwap.
        if (snipeStartBps > 0) {
            snipeConfigs[tokenAddr] = SnipeConfig({
                startBps: snipeStartBps,
                decaySeconds: snipeDecaySeconds,
                launchedAt: uint64(block.timestamp)
            });
            emit SnipeConfigured(tokenAddr, snipeStartBps, snipeDecaySeconds);
        }

        emit TokenLaunched(tokenAddr, msg.sender, mode, name, symbol, metadataURI);

        // Initialise the V4 pool. msg.sender on the PoolManager call site is
        // this hook, which beforeInitialize relies on to gate creation to the
        // canonical createLaunch path. We pick tick 0 as the start sqrtPrice;
        // the curve hook overrides every swap so the AMM's starting price is
        // irrelevant during the Curving phase.
        POOL_MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(0));

        emit LaunchCreated(poolId, tokenAddr, msg.sender, mode);
    }

    // -------------------------------------------------------------------
    // ILaunchpadSnipe (anti-sniper config read by the prior hook prototype,
    // kept here so the same surface works against the unified hook).
    // -------------------------------------------------------------------

    /// @notice Current snipe tax rate (bps) for `token`. Linear decay from
    ///         `startBps` at launch to 0 after `decaySeconds`. Returns 0 if
    ///         the token has no snipe config or the window has elapsed.
    function currentSnipeBps(address token) external view returns (uint256) {
        SnipeConfig memory cfg = snipeConfigs[token];
        if (cfg.startBps == 0 || cfg.decaySeconds == 0 || cfg.launchedAt == 0) return 0;
        uint256 elapsed = block.timestamp - cfg.launchedAt;
        if (elapsed >= cfg.decaySeconds) return 0;
        return (uint256(cfg.startBps) * (cfg.decaySeconds - elapsed)) / cfg.decaySeconds;
    }

    // -------------------------------------------------------------------
    // Owner controls
    // -------------------------------------------------------------------

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(TREASURY, newTreasury);
        TREASURY = newTreasury;
    }

    function setTwitterEscrow(address newEscrow) external onlyOwner {
        // Zero address is intentional: clears the escrow target entirely.
        emit TwitterEscrowUpdated(twitterEscrow, newEscrow);
        twitterEscrow = newEscrow;
    }

    // -------------------------------------------------------------------
    // Hook callbacks - FOUNDATION ONLY
    //
    // All callbacks the hook claims (per getHookPermissions) return the
    // selector + safe default delta. Round 3 fills in beforeSwap, Round 4
    // graduation, Round 5 royalty + locked LP.
    //
    // The unused slots (after-remove, both donates, after-remove-returns-delta)
    // revert HookNotImplemented so a misconfigured PoolManager that
    // dispatched to them anyway gets a clear signal.
    // -------------------------------------------------------------------

    /// @inheritdoc IHooks
    function beforeInitialize(address sender, PoolKey calldata key, uint160 /*sqrtPriceX96*/ )
        external
        view
        override
        onlyPoolManager
        returns (bytes4)
    {
        // Only the hook's own createLaunch can spawn pools. Random callers
        // hitting pm.initialize(key, ...) with our hook address would
        // otherwise be able to register a pool with a token that isn't ours.
        if (sender != address(this)) revert OnlyLaunchpad();

        // Exactly one currency must be USDC. This guards against future
        // accidental registration of a non-USDC pair under our hook.
        bool c0IsUsdc = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        bool c1IsUsdc = Currency.unwrap(key.currency1) == Currency.unwrap(USDC);
        if (c0IsUsdc == c1IsUsdc) revert NotUsdcPair();

        address launchToken = c0IsUsdc ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        if (!registeredLaunches[launchToken]) revert LaunchNotRegistered();

        return IHooks.beforeInitialize.selector;
    }

    /// @inheritdoc IHooks
    function afterInitialize(
        address, /*sender*/
        PoolKey calldata, /*key*/
        uint160, /*sqrtPriceX96*/
        int24 /*tick*/
    ) external view override onlyPoolManager returns (bytes4) {
        // State for this pool (CurveState + FeeOwner + poolIdOf) was already
        // populated atomically in createLaunch, before the initialize call.
        // Nothing else to do here; the selector return is the contract.
        return IHooks.afterInitialize.selector;
    }

    /// @inheritdoc IHooks
    function beforeAddLiquidity(
        address, /*sender*/
        PoolKey calldata, /*key*/
        ModifyLiquidityParams calldata, /*params*/
        bytes calldata /*hookData*/
    ) external view override onlyPoolManager returns (bytes4) {
        // Round 5 fills in:
        //   - if status == Curving: revert LiquidityNotPermitted
        //   - if status == Graduated && CLANKER_V3: revert (single-sided lock)
        //   - if status == Graduated && PUMP/CLANK && sender != self: revert
        //   - sender == address(this): allow (graduation-seed only)
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @inheritdoc IHooks
    function afterAddLiquidity(
        address, /*sender*/
        PoolKey calldata, /*key*/
        ModifyLiquidityParams calldata, /*params*/
        BalanceDelta, /*delta*/
        BalanceDelta, /*feesAccrued*/
        bytes calldata /*hookData*/
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        // Round 5 fills in:
        //   - compute positionKey
        //   - positions[positionKey] = {owner: creator, liquidity, locked: true}
        //   - mint ERC-6909 receipt to LOCKED_VAULT
        //   - emit PositionLocked
        return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    /// @inheritdoc IHooks
    function beforeRemoveLiquidity(
        address, /*sender*/
        PoolKey calldata, /*key*/
        ModifyLiquidityParams calldata, /*params*/
        bytes calldata /*hookData*/
    ) external view override onlyPoolManager returns (bytes4) {
        // Round 5 fills in (ORDER MATTERS):
        //   1. if params.liquidityDelta == 0 && sender == address(this): allow
        //      (fee-harvest path)
        //   2. compute positionKey; if positions[positionKey].locked: revert
        //   3. otherwise allow
        return IHooks.beforeRemoveLiquidity.selector;
    }

    /// @inheritdoc IHooks
    function beforeSwap(
        address, /*sender*/
        PoolKey calldata key,
        SwapParams calldata, /*params*/
        bytes calldata /*hookData*/
    ) external view override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId poolId = key.toId();
        CurveState storage state = curveStates[poolId];

        // GraduationStarted: every concurrent swap during graduation reverts so
        // there is exactly one tx that observes the transition. Round 4 sets
        // and clears this status atomically inside its own graduation path.
        if (state.status == uint8(Status.GraduationStarted)) revert GraduationInProgress();

        // Curving: the pool has no LP during the bonding curve phase, so the
        // V4 swap path cannot work (PoolManager.take would fail trying to
        // pull USDC from a manager with no reserves). Force traders through
        // the direct hook.buy / hook.sell entrypoints below which use plain
        // ERC20 transferFrom, matching the V2 production launchpad's pattern.
        if (state.status == uint8(Status.Curving)) revert LiquidityNotPermitted();

        // Graduated: swaps go through the canonical AMM plus the post-grad
        // royalty (Round 5). For the Round 3 pass the swap falls through to
        // canonical with no hook contribution. Anti-sniper application is
        // wired in Round 5 alongside the royalty path.
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // -------------------------------------------------------------------
    // Direct curve entrypoints (used during the Curving phase)
    //
    // The V4 swap mechanism is incompatible with a zero-liquidity custom
    // curve: PoolManager.take fails if the manager has no underlying balance
    // to forward, and adding LP during curving defeats the curve's purpose
    // (LPs would extract value from buyers). Instead, the hook exposes its
    // own buy / sell entrypoints that move USDC and launch tokens via plain
    // ERC20 transferFrom + transfer. This mirrors the V2 production
    // launchpad pattern and is what the Arcade frontend already speaks.
    //
    // Post-graduation (Round 4+), swaps return to the V4 router path because
    // the graduated pool has real liquidity backing the AMM math.
    // -------------------------------------------------------------------

    /**
     * @notice Buy launch tokens on the bonding curve. Pulls USDC from the
     *         caller via transferFrom, executes the curve math, distributes
     *         the curve fee per mode, and transfers tokens to the caller.
     *
     * @param token       Launch token (must be in registeredLaunches).
     * @param amountIn    USDC the buyer is willing to spend (6 dp).
     * @param minTokensOut Slippage floor on the tokens received.
     * @return tokensOut  Tokens delivered to the caller.
     * @return actualGross USDC actually consumed (== amountIn unless the
     *                    buy hits the graduation cap, deferred to Round 4).
     */
    function buy(address token, uint256 amountIn, uint256 minTokensOut)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 tokensOut, uint256 actualGross)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (!registeredLaunches[token]) revert LaunchNotRegistered();

        PoolId poolId = poolIdOf[token];
        CurveState storage state = curveStates[poolId];
        if (state.status == uint8(Status.GraduationStarted)) revert GraduationInProgress();
        if (state.status == uint8(Status.Graduated)) revert LiquidityNotPermitted();
        if (state.mode == uint8(LaunchMode.CLANKER_V3)) revert InvalidMode();

        ArcadeV4Curve.BuyResult memory r =
            ArcadeV4Curve.simulateBuy(state.tokensSold, state.realUsdcReserve, amountIn);

        // Round 4: cap-path buys trigger graduation. For the Round 3 cut we
        // revert so the UI can prompt a graduation flow once Round 4 ships.
        if (r.refund > 0) revert GraduationInProgress();
        if (r.tokensOut == 0) revert ZeroAmount();
        if (r.tokensOut < minTokensOut) revert ZeroAmount(); // slippage guard, reuses ZeroAmount

        // Pull the gross USDC from the buyer into the hook.
        IERC20(Currency.unwrap(USDC)).safeTransferFrom(msg.sender, address(this), r.actualGross);

        // Distribute the curve fee out of the hook's accumulating balance.
        _distributeCurveFee(state.mode, r.fee, state.creator, state.creator2, state.creator2Bps);

        // Ship launch tokens to the buyer from the hook's balance.
        IERC20(token).safeTransfer(msg.sender, r.tokensOut);

        // State update last (CEI).
        state.tokensSold += uint128(r.tokensOut);
        state.realUsdcReserve += uint128(r.actualGross - r.fee);

        emit CurveBuy(poolId, msg.sender, r.actualGross, r.tokensOut);
        return (r.tokensOut, r.actualGross);
    }

    /**
     * @notice Sell launch tokens back into the bonding curve. Pulls tokens
     *         from the caller via transferFrom, executes the curve math,
     *         distributes the curve fee per mode, and pays USDC to the
     *         caller. Dust sells that round to zero output revert with
     *         ZeroAmount rather than silently no-op'ing so the UI surfaces a
     *         clear "too small to sell" message.
     *
     * @param token       Launch token (must be in registeredLaunches).
     * @param tokensIn    Tokens the seller is sending in (18 dp).
     * @param minUsdcOut  Slippage floor on the USDC received.
     * @return usdcOut    USDC delivered to the caller (after curve fee).
     */
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdcOut)
    {
        if (tokensIn == 0) revert ZeroAmount();
        if (!registeredLaunches[token]) revert LaunchNotRegistered();

        PoolId poolId = poolIdOf[token];
        CurveState storage state = curveStates[poolId];
        if (state.status == uint8(Status.GraduationStarted)) revert GraduationInProgress();
        if (state.status == uint8(Status.Graduated)) revert LiquidityNotPermitted();
        if (state.mode == uint8(LaunchMode.CLANKER_V3)) revert InvalidMode();

        ArcadeV4Curve.SellResult memory r =
            ArcadeV4Curve.simulateSell(state.tokensSold, state.realUsdcReserve, tokensIn);
        if (r.usdcOut == 0) revert ZeroAmount();
        if (r.usdcOut < minUsdcOut) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        // Distribute the curve fee out of the hook's accumulated USDC, then
        // pay the net to the seller. The fee comes out FIRST so the seller's
        // payout never includes USDC that's about to be re-routed to creator
        // or treasury.
        _distributeCurveFee(state.mode, r.fee, state.creator, state.creator2, state.creator2Bps);
        IERC20(Currency.unwrap(USDC)).safeTransfer(msg.sender, r.usdcOut);

        state.tokensSold -= uint128(tokensIn);
        state.realUsdcReserve -= uint128(r.grossOut);

        emit CurveSell(poolId, msg.sender, tokensIn, r.usdcOut);
        return r.usdcOut;
    }

    /// @inheritdoc IHooks
    function afterSwap(
        address, /*sender*/
        PoolKey calldata, /*key*/
        SwapParams calldata, /*params*/
        BalanceDelta, /*delta*/
        bytes calldata /*hookData*/
    ) external view override onlyPoolManager returns (bytes4, int128) {
        // Curving: curve fee was already taken inline in beforeSwap, so
        // afterSwap has nothing to do.
        // Graduated: Round 5 fills in the post-grad royalty + anti-sniper
        // skim path here.
        return (IHooks.afterSwap.selector, int128(0));
    }

    // -------------------------------------------------------------------
    // Unused IHooks slots - revert. The mined address has zero bits at
    // positions 8, 5, 4, 0 so PoolManager never dispatches here.
    // -------------------------------------------------------------------

    /// @inheritdoc IHooks
    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    /// @inheritdoc IHooks
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    // -------------------------------------------------------------------
    // Views for indexers + the frontend
    // -------------------------------------------------------------------

    function tokensCount() external view returns (uint256) {
        return allTokens.length;
    }

    function getCurveState(PoolId poolId) external view returns (CurveState memory) {
        return curveStates[poolId];
    }

    function getFeeOwner(PoolId poolId) external view returns (FeeOwner memory) {
        return feeOwners[poolId];
    }

    // -------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------

    /// @dev Canonical PoolKey for a launch. Sorts the currencies by address
    ///      so currency0 < currency1 (v4 invariant), then sets the hook to
    ///      this contract. POOL_FEE / TICK_SPACING are constants because
    ///      every Arcade pool uses the same 1% / 200 layout (parity with the
    ///      production V3 high-fee tier).
    function _buildPoolKey(address launchToken) internal view returns (PoolKey memory key) {
        address usdcAddr = Currency.unwrap(USDC);
        (Currency c0, Currency c1) = usdcAddr < launchToken
            ? (USDC, Currency.wrap(launchToken))
            : (Currency.wrap(launchToken), USDC);
        key = PoolKey({currency0: c0, currency1: c1, fee: 10_000, tickSpacing: 200, hooks: IHooks(address(this))});
    }

    /// @dev Mode-driven curve fee split. PUMP = 50/50, CLANKER = 70/30,
    ///      CLANKER_V3 = n/a (no curve, swap reverts earlier).
    ///      Transfers happen synchronously in USDC out of the hook's own
    ///      balance, NOT via pm.take, because curve fees are bookkept in the
    ///      hook's accumulating realUsdcReserve balance.
    function _distributeCurveFee(uint8 mode, uint256 fee, address creator, address creator2, uint16 creator2Bps)
        internal
    {
        if (fee == 0) return;
        IERC20 usdc = IERC20(Currency.unwrap(USDC));

        uint256 platformBps = mode == uint8(LaunchMode.CLANKER) ? 7_000 : 5_000;
        uint256 platformCut = (fee * platformBps) / 10_000;
        uint256 creatorCut = fee - platformCut;

        if (creator2 != address(0) && creator2Bps > 0 && mode == uint8(LaunchMode.CLANKER)) {
            uint256 c2Cut = (creatorCut * creator2Bps) / 10_000;
            if (c2Cut > 0) {
                usdc.safeTransfer(creator2, c2Cut);
                creatorCut -= c2Cut;
            }
        }

        if (platformCut > 0) usdc.safeTransfer(TREASURY, platformCut);
        if (creatorCut > 0) usdc.safeTransfer(creator, creatorCut);
    }

}
