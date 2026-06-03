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
     * @notice Register a new launch and deploy its ERC20. Pulls the flat
     *         creation fee in USDC straight to treasury. The launch is now
     *         eligible for `initializePool` (Round 3+); the curve does NOT
     *         start until the pool is initialised.
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
    ) external nonReentrant whenNotPaused returns (address tokenAddr) {
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        if (mode > uint8(LaunchMode.CLANKER_V3)) revert InvalidMode();
        if (creator2Bps > 10_000) revert InvalidFeeOwner();
        if (snipeStartBps > MAX_SNIPE_START_BPS) revert InvalidSnipeBps();
        if (snipeStartBps > 0 && snipeDecaySeconds == 0) revert InvalidDecaySeconds();

        // Pull the creation fee first so we don't waste a token deploy on a
        // user who hasn't approved.
        IERC20(Currency.unwrap(USDC)).safeTransferFrom(msg.sender, TREASURY, CREATION_FEE);

        ArcadeLaunchToken token = new ArcadeLaunchToken(name, symbol, ArcadeV4Curve.TOTAL_SUPPLY, address(this));
        tokenAddr = address(token);
        if (registeredLaunches[tokenAddr]) revert AlreadyLaunched();

        registeredLaunches[tokenAddr] = true;
        allTokens.push(tokenAddr);

        // Snipe config is per-token, stored under the launch token address so
        // `currentSnipeBps(token)` works from the hook's swap path with no
        // additional state lookups.
        if (snipeStartBps > 0) {
            snipeConfigs[tokenAddr] = SnipeConfig({
                startBps: snipeStartBps,
                decaySeconds: snipeDecaySeconds,
                launchedAt: uint64(block.timestamp)
            });
            emit SnipeConfigured(tokenAddr, snipeStartBps, snipeDecaySeconds);
        }

        // FeeOwner is stored under the token addr now; we move it to the
        // PoolId mapping in beforeInitialize once the pool is created. Doing
        // it here means a deferred initializePool still finds the owner cfg.
        // We use a sentinel-style storage trick: createLaunch writes to a
        // dedicated _pendingFeeOwners mapping that beforeInitialize promotes
        // to feeOwners[poolId]. This is implemented in Round 3 alongside
        // beforeInitialize; for the foundation pass we just emit the event
        // so indexers can pick the launch up immediately.

        emit TokenLaunched(tokenAddr, msg.sender, mode, name, symbol, metadataURI);
        // _pendingFeeOwners + bootstrap of fee config happen in Round 3.
        // creator2 / creator2Bps stashed via a future internal helper there.
        // Reference args to silence unused-warning during this scaffold.
        (creator2, creator2Bps);
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
    function beforeInitialize(address, /*sender*/ PoolKey calldata, /*key*/ uint160 /*sqrtPriceX96*/ )
        external
        view
        override
        onlyPoolManager
        returns (bytes4)
    {
        // Round 3 fills in:
        //   - msg.sender check (already onlyPoolManager)
        //   - sender == address(this) check (only the hook's own init flow)
        //   - registeredLaunches[token] == true
        //   - exactly one currency is USDC
        // For the foundation, accept all calls so test scaffolding can spin up
        // a pool without an end-to-end createLaunch flow.
        return IHooks.beforeInitialize.selector;
    }

    /// @inheritdoc IHooks
    function afterInitialize(
        address, /*sender*/
        PoolKey calldata, /*key*/
        uint160, /*sqrtPriceX96*/
        int24 /*tick*/
    ) external override onlyPoolManager returns (bytes4) {
        // Round 3 fills in: emit LaunchCreated, lock CurveState immutable
        // virtualUsdcReserve = 5_000e6, set status = Curving.
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
        PoolKey calldata, /*key*/
        SwapParams calldata, /*params*/
        bytes calldata /*hookData*/
    ) external view override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        // Round 3 fills in:
        //   - status Curving: run curve math via ArcadeV4Curve, return delta
        //     that neutralises canonical AMM, set dynamic fee TRADE_FEE_BPS
        //   - status GraduationStarted: revert GraduationInProgress
        //   - status Graduated: apply anti-sniper if window active
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @inheritdoc IHooks
    function afterSwap(
        address, /*sender*/
        PoolKey calldata, /*key*/
        SwapParams calldata, /*params*/
        BalanceDelta, /*delta*/
        bytes calldata /*hookData*/
    ) external override onlyPoolManager returns (bytes4, int128) {
        // Round 5 fills in:
        //   - status Curving: no-op (fee taken inline in beforeSwap)
        //   - status Graduated: split POST_GRAD_ROYALTY_BPS per mode,
        //     try escrow.creditSlot wrapped in try/catch, else direct transfer
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
}
