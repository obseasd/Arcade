// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ArcadeLaunchToken} from "../src/launchpad/ArcadeLaunchToken.sol";
import {ArcadeV4Curve} from "./libraries/ArcadeV4Curve.sol";
import {ILaunchpadSnipe} from "./interfaces/ILaunchpadSnipe.sol";

/// @notice Minimal subset of the ArcadeTwitterEscrowV4 surface the hook calls
///         to credit a Twitter-handle slot with creator fees. Kept in this file
///         so the V4 stack does not import the full escrow source. The `slot`
///         is uint256 to match the escrow's ABI byte-for-byte (a uint8 here
///         would compute a DIFFERENT selector and silently miss the call).
interface IArcadeTwitterEscrowV3Min {
    function creditSlot(uint256 positionId, uint256 slot, address token, uint256 amount) external;
}

// v4-core upstream.
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {ArcadeV4Math} from "./libraries/ArcadeV4Math.sol";

/**
 * @title ArcadeHook
 * @notice Unified Uniswap V4 hook for the Arcade launchpad. Subsumes the V2
 *         stack (Factory + Pair + Router + Launchpad + V3 Locker) into a
 *         single hook bound to one canonical PoolManager on Arc.
 *
 *         The hook owns the full launch lifecycle:
 *           - createLaunch: deploys ArcadeLaunchToken (1B minted here), pulls
 *             the USDC creation fee, configures fee owners + optional CLANKER
 *             fee tier, anti-sniper, and Twitter-handle fee attribution.
 *           - Bonding curve (hook.buy/hook.sell) during Curving, then atomic
 *             graduation into a locked full-range V4 LP.
 *           - Post-graduation fee capture in before/afterSwap: the whole trading
 *             fee, always in USDC, split 80/20 creator/treasury, with a
 *             mcap-decaying PUMP fee / fixed CLANKER tier + anti-sniper auction.
 *           - Permission bitmap 0x3ECE (10 bits); the 4 unused callbacks revert.
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
contract ArcadeHook is IHooks, IUnlockCallback, Ownable2Step, Pausable, ReentrancyGuard, ILaunchpadSnipe {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

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
        // Stored at init = ArcadeV4Curve.VIRTUAL_USDC_RESERVE (5_800e6), but
        // INFORMATIONAL ONLY: the curve math reads the library constant, never
        // this field. Kept for off-chain readers; do not compute against it.
        uint128 virtualUsdcReserve;
        uint128 realUsdcReserve; // climbs to ~14_209e6 at graduation (GRADUATION_USDC)
        uint128 tokensSold; // climbs to CURVE_SUPPLY (806M)
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
        uint16 feeTierBps; // CLANKER: creator-chosen fee tier (100/200/300). 0 for PUMP (dynamic).
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
        uint64 launchedAt; // 0 until graduation; then block.timestamp of graduation (decay anchor)
    }

    /// @notice Manipulation-resistant price oracle feeding the PUMP dynamic
    ///         fee. Tracks an EMA of the pool's "mcap tick" (the slot0 tick
    ///         sign-normalised so it always RISES with market cap regardless of
    ///         USDC's currency ordering). Seeded at graduation; updated at most
    ///         once per block timestamp in afterSwap, never on the swap that
    ///         reads it, so a swap can never move the fee it itself pays.
    struct FeeObs {
        int64 emaTickE3; // EMA of the mcap tick, scaled x1e3 for sub-tick precision
        int24 gradMcapTick; // mcap tick captured at graduation (fee-decay reference)
        uint32 lastTs; // timestamp of the last EMA update
        bool init; // true once seeded at graduation
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
    /// @notice Configured recipient of locked LP claim tokens. NOTE: the
    ///         graduation-seed / CLANKER-init position is added by the hook
    ///         itself via POOL_MANAGER.modifyLiquidity, so v4-core keys the
    ///         position to the HOOK (address(this)), and `noSelfCall` skips the
    ///         hook's own afterAddLiquidity, so NO ERC-6909 receipt is minted to
    ///         this vault and the `positions`/`locked` bookkeeping never runs for
    ///         the seed. The LP is nonetheless unremovable: there is no
    ///         negative-delta modifyLiquidity path anywhere in the hook, so the
    ///         position can never be withdrawn. This immutable + the
    ///         `positions`/beforeRemoveLiquidity guard are retained defensively
    ///         but are inert for the seed; do NOT rely on "the vault holds the
    ///         receipts" as the lock proof.
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

    // --- New fee model (2026-07-17 redesign, replaces the 1% pool fee + 0.30%
    //     royalty). Pool LP fee set to 0; the hook captures the WHOLE trading
    //     fee in before/afterSwap, always in USDC, split creator/treasury.
    //     Being wired in slices: capture -> PUMP dynamic mcap fee -> CLANKER
    //     tier -> mode merge. See project_arcade_v4_analysis memory. ---
    /// @notice Creator's share of the post-graduation trading fee (80%);
    ///         treasury takes the remaining 20%.
    uint16 internal constant POST_GRAD_CREATOR_BPS = 8_000;
    /// @notice CLANKER-mode selectable fee tiers (creator picks one at launch).
    ///         PUMP mode ignores this and uses the mcap-decaying dynamic fee.
    uint16 internal constant FEE_TIER_1 = 100; // 1%
    uint16 internal constant FEE_TIER_2 = 200; // 2%
    uint16 internal constant FEE_TIER_3 = 300; // 3%
    /// @notice PUMP dynamic-fee bounds: starts at ~1% for a fresh graduate and
    ///         decays with market cap down to 0.30% for a mature token.
    uint16 internal constant PUMP_FEE_MAX_BPS = 100; // 1% at graduation
    uint16 internal constant PUMP_FEE_MIN_BPS = 30; // 0.30% mature floor
    /// @notice Market-cap growth (measured in EMA ticks above the graduation
    ///         tick) at which the PUMP fee reaches its 0.30% floor. Ticks are
    ///         log-price, so a fixed tick span is a fixed MCAP MULTIPLE:
    ///         23_026 ticks = ln(10)/ln(1.0001) ~= 10x market cap. The PUMP fee
    ///         decays LINEARLY IN LOG-MCAP from 1% at graduation to 0.30% once
    ///         the token has ~10x'd. Retunable without touching the math.
    int256 internal constant PUMP_FEE_FLOOR_TICKS = 23_026;
    /// @notice Smoothing time-constant (seconds) for the price EMA that feeds
    ///         the PUMP dynamic fee. A single update moves the EMA at most
    ///         dt/(dt+TAU) toward spot, capped at 50% (dt clamped to TAU), so a
    ///         one-block price spike can never swing the fee: the oracle only
    ///         updates once per timestamp and never on the swap that reads it.
    uint256 internal constant EMA_TAU_SECONDS = 3_600; // 1 hour

    /// @notice CLANKER (direct) launch: default + bounds for the starting market
    ///         cap when the creator passes 0. The full supply is seeded
    ///         single-sided in the V4 pool at this FDV; buyers push the price up
    ///         from here (no bonding curve). Mirrors V2 CLANKER_V3's ~$35k start.
    uint256 internal constant CLANKER_DEFAULT_START_MCAP = 35_000e6; // $35k
    uint256 internal constant CLANKER_MIN_START_MCAP = 1_000e6; // $1k
    uint256 internal constant CLANKER_MAX_START_MCAP = 10_000_000e6; // $10M
    /// @notice Hard safety cap on the TOTAL afterSwap take (fee + anti-sniper).
    ///         v4-core bricks a swap when the take exceeds 100% of the
    ///         unspecified side; we clamp well below. Max legit = 50% snipe +
    ///         3% fee = 53%, so 60% leaves margin while staying < 100%.
    uint16 internal constant MAX_TOTAL_TAKE_BPS = 6_000; // 60%, hard brick guard

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
    /// @notice Price EMA per graduated pool, feeding the PUMP dynamic fee.
    mapping(PoolId => FeeObs) public feeObs;
    /// @notice Static V4 LP fee baked into each launch's PoolKey. PUMP = 0 (the
    ///         hook captures the fee in before/afterSwap); CLANKER = its tier
    ///         (1%/2%/3% -> 10000/20000/30000) charged natively by the pool and
    ///         accrued to the hook-owned locked LP, harvested via collectFees.
    ///         Read by _buildPoolKey so the PoolId is consistent everywhere; MUST
    ///         be set before the first _buildPoolKey call for a token.
    mapping(address => uint24) public poolFeeOf;

    /// @notice CLANKER single-sided locked-LP position range per token, so
    ///         collectFees can address it (modifyLiquidity keys by tick range).
    struct ClankerPos {
        int24 tickLower;
        int24 tickUpper;
        bool seeded;
        uint64 launchedAt; // for the first-window anti-snipe buy cap
    }
    mapping(address => ClankerPos) public clankerPos;

    /// @notice CLANKER anti-snipe buy cap: reject buys whose CUMULATIVE token
    ///         output in a single block tops `clankerMaxBuyBps` of TOTAL_SUPPLY,
    ///         within `clankerCapWindowSecs` of launch. Per-BLOCK cumulative (not
    ///         per-swap) so an atomic multi-swap batch can't split under the cap.
    ///         Owner-tunable (setClankerBuyCap); 0 bps disables.
    uint16 public clankerMaxBuyBps;
    uint32 public clankerCapWindowSecs;
    /// @dev token => (block number, tokens bought so far this block). Resets on
    ///      a new block. Bounds total in-window block-0 accumulation.
    struct BlockBuy {
        uint64 blockNumber;
        uint192 bought;
    }
    mapping(address => BlockBuy) internal clankerBlockBuy;
    /// @notice Launch token => PoolId so `currentSnipeBps` callers (the hook
    ///         itself + indexers) can look up the curve state from a token addr.
    mapping(address => PoolId) public poolIdOf;

    /// @notice Append-only registry for indexer enumeration.
    address[] public allTokens;

    /// @notice (token, recipient) => credited amount the recipient can pull via
    ///         `claimPendingToken`. Populated whenever an inline payout (curve
    ///         fee, migration fee, post-grad royalty) reverts because the
    ///         recipient is USDC-blocked (or any other transfer-rejecting
    ///         condition). CSEC-001: prevents one blocked address from DOSing
    ///         every swap on a graduated pool.
    mapping(address => mapping(address => uint256)) public pendingTokenWithdrawals;

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
    error Slippage(); // curve buy/sell output below the caller's min
    error InvalidMode();
    error InvalidFeeTier();
    error InvalidStartMcap();
    error InvalidFeeOwner();
    error InvariantBroken();
    error ZeroAddress();
    error EmptyName();
    error InvalidSnipeBps();
    error InvalidDecaySeconds();
    error BuyExceedsCap();
    error AlreadyLaunched();
    error NothingToWithdraw();

    // -------------------------------------------------------------------
    // Events (frozen per V4_HOOK_SPEC.md Section 14)
    // -------------------------------------------------------------------

    event LaunchCreated(PoolId indexed poolId, address indexed token, address creator, uint8 mode);
    /// @notice Emitted when a CLANKER launch attributes its creator fees to a
    ///         Twitter handle. The backend binds `poolId` <-> `handle` here; the
    ///         handle is NOT stored on-chain (the escrow keys by poolId only).
    event FeeAttributedToHandle(PoolId indexed poolId, address indexed escrow, string handle);
    event CurveBuy(PoolId indexed poolId, address indexed buyer, uint256 grossUsdcIn, uint256 tokensOut);
    event CurveSell(PoolId indexed poolId, address indexed seller, uint256 tokensIn, uint256 usdcOut);
    event Graduated(PoolId indexed poolId, uint256 finalUsdcReserve, uint256 tokensInLP);
    // `currency` disambiguates the fee token: post-grad PUMP + graduation fees
    // are always USDC, but a CLANKER harvest emits RoyaltyPaid for BOTH the USDC
    // and the launch-token side. Indexers must key USDC fee stats off currency
    // == USDC, or a token-denominated (18dp) amount pollutes the 6dp USDC tally.
    event RoyaltyPaid(
        PoolId indexed poolId,
        address indexed creator,
        uint256 creatorAmount,
        uint256 treasuryAmount,
        address currency
    );
    event AntiSnipeApplied(PoolId indexed poolId, address indexed sniper, uint256 amount, uint16 bps);
    event EscrowCreditFailed(uint256 indexed positionId, uint8 slot, uint256 amount);
    event PositionLocked(bytes32 indexed positionKey, address indexed owner, uint128 liquidity);
    event FeeHarvested(bytes32 indexed positionKey, uint256 amount0, uint256 amount1);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event TwitterEscrowUpdated(address indexed oldEscrow, address indexed newEscrow);
    event ClankerBuyCapSet(uint16 maxBuyBps, uint32 windowSecs);
    event SnipeConfigured(address indexed token, uint16 startBps, uint32 decaySeconds);
    event TokenCredited(address indexed token, address indexed recipient, uint256 amount);
    event TokenPendingClaimed(address indexed token, address indexed recipient, uint256 amount);
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

        // Default CLANKER anti-snipe cap: 1% of supply per buy for the first 5
        // minutes. Owner-tunable (or disable with 0 bps) via setClankerBuyCap.
        clankerMaxBuyBps = 100;
        clankerCapWindowSecs = 300;
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
     * @param feeTier          CLANKER only: the fixed post-graduation trading
     *                          fee tier, 1 (1%), 2 (2%) or 3 (3%). IGNORED for
     *                          PUMP, which uses the mcap-decaying dynamic fee.
     * @param twitterHandle    CLANKER only: pass a non-empty handle to route the
     *                          launch's creator fees to a handle-gated escrow
     *                          slot (claimable by the verified handle owner)
     *                          instead of the launcher's wallet. Requires the
     *                          hook to have a `twitterEscrow` wired. Emitted
     *                          (not stored) so the backend binds poolId<->handle.
     *                          Empty string (or PUMP) = fees go direct.
     */
    function createLaunch(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint8 mode,
        address creator2,
        uint16 creator2Bps,
        uint16 snipeStartBps,
        uint32 snipeDecaySeconds,
        uint8 feeTier,
        string calldata twitterHandle,
        uint256 startMcapUsdc
    ) external nonReentrant whenNotPaused returns (address tokenAddr, PoolId poolId) {
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        // Two modes: PUMP(0) = bonding curve -> graduate; CLANKER(1) = DIRECT
        // single-sided locked-LP launch (no curve, tier fee from the first swap).
        // CLANKER_V3(2)+ rejected.
        if (mode >= uint8(LaunchMode.CLANKER_V3)) revert InvalidMode();
        if (creator2Bps > 10_000) revert InvalidFeeOwner();
        if (snipeStartBps > MAX_SNIPE_START_BPS) revert InvalidSnipeBps();
        if (snipeStartBps > 0 && snipeDecaySeconds == 0) revert InvalidDecaySeconds();
        // Anti-sniper rides the hook fee-take, which CLANKER's single-sided pool
        // cannot support (no USDC reserve to take). Reject a snipe config on
        // CLANKER instead of silently accepting a no-op the creator pays for --
        // the tier LP fee is CLANKER's only friction. (Audit 2026-07-18.)
        if (mode == uint8(LaunchMode.CLANKER) && snipeStartBps > 0) revert InvalidSnipeBps();
        // The secondary fee recipient is a CLANKER-only feature (PUMP routes its
        // whole creator cut to the launcher in both the curve and post-grad
        // paths). Reject a creator2 config on PUMP rather than silently ignoring
        // funds the caller meant to split. (Audit 2026-07-18.)
        if (mode == uint8(LaunchMode.PUMP) && (creator2 != address(0) || creator2Bps > 0)) {
            revert InvalidFeeOwner();
        }

        // CLANKER creators pick a fixed fee tier (1/2/3 = 1%/2%/3%) and a
        // starting market cap for the single-sided seed. PUMP ignores both and
        // runs the bonding curve + mcap-decaying dynamic fee.
        uint16 feeTierBps = 0;
        uint256 startMcap = 0;
        if (mode == uint8(LaunchMode.CLANKER)) {
            feeTierBps = _resolveFeeTierBps(feeTier);
            startMcap = startMcapUsdc == 0 ? CLANKER_DEFAULT_START_MCAP : startMcapUsdc;
            if (startMcap < CLANKER_MIN_START_MCAP || startMcap > CLANKER_MAX_START_MCAP) {
                revert InvalidStartMcap();
            }
        }

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

        // Pool fee: PUMP = 0 (the hook captures the fee in before/afterSwap);
        // CLANKER = its tier as a native V4 LP fee. MUST be set BEFORE the first
        // _buildPoolKey so the PoolId encodes the correct fee everywhere.
        poolFeeOf[tokenAddr] = mode == uint8(LaunchMode.CLANKER) ? _tierToV4Fee(feeTierBps) : 0;

        // Build the canonical PoolKey for this launch and persist EVERYTHING
        // beforeInitialize / afterInitialize / beforeSwap will need, BEFORE
        // calling pm.initialize. This way the lifecycle callbacks find a
        // fully-formed state and never have to defer.
        PoolKey memory key = _buildPoolKey(tokenAddr);
        poolId = key.toId();
        poolIdOf[tokenAddr] = poolId;

        // PUMP starts in the Curving phase; CLANKER is seeded directly into the
        // AMM below and is Graduated (fee-capturing) from the first swap.
        curveStates[poolId] = CurveState({
            virtualUsdcReserve: uint128(ArcadeV4Curve.VIRTUAL_USDC_RESERVE),
            realUsdcReserve: 0,
            tokensSold: 0,
            mode: mode,
            status: mode == uint8(LaunchMode.PUMP) ? uint8(Status.Curving) : uint8(Status.Graduated),
            creator: msg.sender,
            creator2: creator2,
            creator2Bps: creator2Bps
        });

        // Optional Twitter-handle fee attribution (CLANKER only). A non-empty
        // handle + a wired escrow routes this launch's CREATOR fees to a
        // handle-gated escrow slot (positionId = poolId, slot 0) instead of the
        // launcher's wallet. Only the hook's own OWNER-configured `twitterEscrow`
        // is used -- a launcher cannot point fees at an arbitrary escrow.
        address launchEscrow = address(0);
        if (
            bytes(twitterHandle).length > 0 && mode == uint8(LaunchMode.CLANKER)
                && twitterEscrow != address(0)
        ) {
            launchEscrow = twitterEscrow;
        }

        feeOwners[poolId] = FeeOwner({
            creator: msg.sender,
            creator2: creator2,
            creator2Bps: creator2Bps,
            feeTierBps: feeTierBps,
            twitterEscrow: launchEscrow,
            slotIndex: 0
        });

        // Snipe config keyed by token addr so currentSnipeBps reads cheaply
        // from anti-sniper checks in beforeSwap / afterSwap.
        //
        // Anti-sniper decay clock: the tax applies in afterSwap on a live AMM
        // pool. For PUMP the pool only exists AFTER graduation, so launchedAt
        // stays 0 here and _graduate stamps it (starting it now would let the
        // window elapse during the hours/days curve -> snipers free, the round-4
        // HIGH). For CLANKER the pool is live at creation, so stamp it NOW.
        if (snipeStartBps > 0) {
            snipeConfigs[tokenAddr] = SnipeConfig({
                startBps: snipeStartBps,
                decaySeconds: snipeDecaySeconds,
                launchedAt: mode == uint8(LaunchMode.PUMP) ? 0 : uint64(block.timestamp)
            });
            emit SnipeConfigured(tokenAddr, snipeStartBps, snipeDecaySeconds);
        }

        emit TokenLaunched(tokenAddr, msg.sender, mode, name, symbol, metadataURI);
        emit LaunchCreated(poolId, tokenAddr, msg.sender, mode);
        if (launchEscrow != address(0)) emit FeeAttributedToHandle(poolId, launchEscrow, twitterHandle);

        // CLANKER: seed the full supply single-sided into a locked V4 LP at the
        // starting market cap. No bonding curve -- the pool is live immediately.
        if (mode == uint8(LaunchMode.CLANKER)) {
            _launchDirect(tokenAddr, key, poolId, startMcap);
        }

        // NOTE: the V4 pool itself is NOT initialised here. During the Curving
        // phase the curve runs through hook.buy / hook.sell with no V4 swap
        // involvement, so the pool need not exist. The pool is initialised
        // atomically inside _graduate at the migration price computed from
        // the final reserve ratio, which gives the post-grad AMM a clean
        // starting price instead of an arbitrary "tick 0" the curve never
        // touched.
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

    /// @notice The live trading fee (bps) a GRADUATED pool currently charges.
    ///         PUMP pools decay from 1% at graduation toward the 0.30% floor as
    ///         market cap grows (driven by the manipulation-resistant price
    ///         EMA); CLANKER pools return their fixed tier. Returns 0 for a
    ///         token that has not graduated. For UI display + off-chain quoting.
    function currentFeeBps(address token) external view returns (uint256) {
        PoolId poolId = poolIdOf[token];
        CurveState memory state = curveStates[poolId];
        if (state.status != uint8(Status.Graduated)) return 0;
        return _feeBps(state.mode, poolId);
    }

    /// @notice Harvest a CLANKER launch's accrued pool LP fees from its locked
    ///         position and distribute them 80/20 (creator/treasury; the USDC
    ///         creator cut routes to the handle escrow when the launch attributed
    ///         to a Twitter handle, the token cut goes direct to the creator).
    ///         Permissionless: anyone can trigger a harvest; funds always follow
    ///         the fixed split. Only CLANKER direct launches (which use the
    ///         native pool fee) have a position to harvest.
    function collectFees(address token) external nonReentrant whenNotPaused {
        if (!clankerPos[token].seeded) revert InvalidMode();
        POOL_MANAGER.unlock(abi.encode(uint8(2), token, uint256(0), uint256(0), int24(0)));
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

    /// @notice Tune the CLANKER first-window anti-snipe buy cap. A single buy
    ///         whose token output exceeds `maxBuyBps` of TOTAL_SUPPLY within
    ///         `windowSecs` of launch reverts. `maxBuyBps == 0` disables it.
    ///         The single-sided CLANKER pool cannot carry a take-based tax, so
    ///         this revert-based cap is its only block-0 snipe defense.
    function setClankerBuyCap(uint16 maxBuyBps, uint32 windowSecs) external onlyOwner {
        // No upper bound needed: bps > 10_000 makes the cap exceed TOTAL_SUPPLY,
        // i.e. unreachable (a harmless "disabled"), same as bps == 0.
        clankerMaxBuyBps = maxBuyBps;
        clankerCapWindowSecs = windowSecs;
        emit ClankerBuyCapSet(maxBuyBps, windowSecs);
    }

    // -------------------------------------------------------------------
    // Pull-payment escape hatch (CSEC-001)
    // -------------------------------------------------------------------

    /// @notice Withdraw any token credited to `msg.sender` from a failed inline
    ///         payout. Permissionless; always pays back to the original
    ///         recipient. The recipient must be unblocked on the underlying
    ///         token before calling.
    function claimPendingToken(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingTokenWithdrawals[token][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingTokenWithdrawals[token][msg.sender] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit TokenPendingClaimed(token, msg.sender, amount);
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
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata, /*params*/
        bytes calldata /*hookData*/
    ) external view override onlyPoolManager returns (bytes4) {
        PoolId poolId = key.toId();
        CurveState storage state = curveStates[poolId];

        // No LP during the bonding curve phase: LPs would extract value from
        // curve buyers. The post-grad pool is also locked after the
        // graduation seed.
        //
        // IMPORTANT: the graduation seed itself does NOT reach this callback.
        // v4-core's Hooks.beforeModifyLiquidity carries `noSelfCall`, so when
        // the hook calls POOL_MANAGER.modifyLiquidity on its OWN pool during
        // _graduate/unlockCallback, this hook is skipped -- otherwise the
        // GraduationStarted guard below would revert the seed and brick
        // graduation. The seed LP's immutability therefore rests on (a) it being
        // a v4 position OWNED BY THE HOOK (v4 keys positions by caller) and (b)
        // the hook exposing no modifyLiquidity(negative delta) path -- NOT on
        // the PositionInfo.locked bookkeeping, which noSelfCall leaves unset.
        if (state.status == uint8(Status.GraduationStarted)) revert GraduationInProgress();
        if (state.status == uint8(Status.Curving)) revert LiquidityNotPermitted();
        // status == Graduated: only the hook itself can add LP. Any external add
        // is rejected so post-graduation LP stays as the locked seed forever.
        if (sender != address(this)) revert LiquidityNotPermitted();
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @inheritdoc IHooks
    function afterAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta, /*delta*/
        BalanceDelta, /*feesAccrued*/
        bytes calldata /*hookData*/
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        // Mark the graduation-seed position as locked. Subsequent
        // beforeRemoveLiquidity calls revert unless liquidityDelta == 0
        // (fee harvest path).
        if (sender == address(this) && params.liquidityDelta > 0) {
            bytes32 positionKey = keccak256(
                abi.encodePacked(sender, params.tickLower, params.tickUpper, params.salt)
            );
            address positionOwner = feeOwners[key.toId()].creator;
            uint128 liquidity = uint128(uint256(params.liquidityDelta));
            positions[positionKey] =
                PositionInfo({owner: positionOwner, liquidity: liquidity, locked: true});
            emit PositionLocked(positionKey, positionOwner, liquidity);
        }
        return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    /// @inheritdoc IHooks
    function beforeRemoveLiquidity(
        address sender,
        PoolKey calldata, /*key*/
        ModifyLiquidityParams calldata params,
        bytes calldata /*hookData*/
    ) external view override onlyPoolManager returns (bytes4) {
        // ORDER MATTERS: the harvest exception MUST be checked before the
        // locked check, or a fee harvest of a locked position would revert.
        // Inverting these creates a fee-harvest DOS on the hook's own LP.
        if (params.liquidityDelta == 0 && sender == address(this)) {
            return IHooks.beforeRemoveLiquidity.selector;
        }

        bytes32 positionKey = keccak256(
            abi.encodePacked(sender, params.tickLower, params.tickUpper, params.salt)
        );
        if (positions[positionKey].locked) revert LockedPosition();
        return IHooks.beforeRemoveLiquidity.selector;
    }

    /// @inheritdoc IHooks
    function beforeSwap(
        address, /*sender*/
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata /*hookData*/
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId poolId = key.toId();
        CurveState memory state = curveStates[poolId];

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

        // Only graduated pools take a trading fee here.
        if (state.status != uint8(Status.Graduated)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // CLANKER charges its fee via the pool's NATIVE static LP fee (the tier),
        // which accrues to the hook-owned locked LP and is harvested by
        // collectFees. The hook takes NOTHING here -- a hook take would try to
        // pull USDC the single-sided pool doesn't hold. Only PUMP (fee-0 pool)
        // captures in the hook.
        if (state.mode == uint8(LaunchMode.CLANKER)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Always-USDC fee guarantee. The fee is ALWAYS charged in USDC. We can
        // only cleanly take on the SPECIFIED side here (beforeSwap deltas act
        // on the specified currency); afterSwap covers the UNSPECIFIED side.
        // So beforeSwap takes iff USDC is the specified currency (buy exact-in
        // = spend exact USDC; sell exact-out = receive exact USDC). When USDC
        // is unspecified, afterSwap takes instead. Exactly one path fires per
        // swap, so the fee is never double-charged.
        bool specifiedIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        Currency specifiedCurrency = specifiedIs0 ? key.currency0 : key.currency1;
        if (Currency.unwrap(specifiedCurrency) != Currency.unwrap(USDC)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Fee is on the specified USDC magnitude.
        uint256 amount = params.amountSpecified < 0
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);
        if (amount == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        uint256 feeBps = _feeBps(state.mode, poolId);
        if (feeBps > MAX_TOTAL_TAKE_BPS) feeBps = MAX_TOTAL_TAKE_BPS;
        uint256 fee = (amount * feeBps) / 10_000;

        // Anti-sniper auction skim on BUYS only. A buy with USDC specified is
        // buy-exact-in (spending exact USDC). USDC specified on a SELL is
        // sell-exact-out (receiving exact USDC), not a buy, so no skim there.
        uint256 snipeSkim = 0;
        if (_isUsdcToTokenSwap(key, params, USDC)) {
            address launchToken = Currency.unwrap(key.currency0) == Currency.unwrap(USDC)
                ? Currency.unwrap(key.currency1)
                : Currency.unwrap(key.currency0);
            uint256 bps = _currentSnipeBps(launchToken);
            if (bps > 0) snipeSkim = (amount * bps) / 10_000;
        }

        // Combined hard cap: fee + snipe <= MAX_TOTAL_TAKE_BPS of the swap.
        // Clamp the snipe first (fee is the creator's core revenue); never
        // revert (a reverting hook bricks every swap on an immutable pool).
        uint256 maxTake = (amount * MAX_TOTAL_TAKE_BPS) / 10_000;
        if (fee > maxTake) fee = maxTake;
        if (fee + snipeSkim > maxTake) snipeSkim = maxTake - fee;

        _payAntiSnipe(poolId, USDC, snipeSkim, amount);
        _distributeFee(poolId, USDC, fee, state.mode, true);

        // Positive specified delta = the hook takes this many USDC units off
        // the specified side, so the swapper pays for everything taken above.
        uint256 totalTaken = fee + snipeSkim;
        return (
            IHooks.beforeSwap.selector,
            toBeforeSwapDelta(int128(int256(totalTaken)), int128(0)),
            0
        );
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

        if (r.tokensOut == 0) revert ZeroAmount();
        if (r.tokensOut < minTokensOut) revert Slippage(); // slippage guard

        // Pull only what the curve actually accepts. In the cap (graduation)
        // path actualGross < amountIn and the residual stays with the buyer
        // automatically since we never transferFrom'd it.
        IERC20(Currency.unwrap(USDC)).safeTransferFrom(msg.sender, address(this), r.actualGross);

        // Distribute the curve fee out of the hook's accumulating balance.
        _distributeCurveFee(state.mode, r.fee, state.creator, state.creator2, state.creator2Bps);

        // Ship launch tokens to the buyer from the hook's balance.
        IERC20(token).safeTransfer(msg.sender, r.tokensOut);

        // NOTE: the transfers above run BEFORE this state update (not CEI). This
        // is safe ONLY because (a) `nonReentrant` guards buy(), and (b) USDC and
        // ArcadeLaunchToken have no transfer callbacks, so no re-entrant read of
        // the stale reserves is possible. Do NOT introduce a callback-bearing
        // fee currency or launch token without moving these effects earlier.
        state.tokensSold += uint128(r.tokensOut);
        state.realUsdcReserve += uint128(r.actualGross - r.fee);

        emit CurveBuy(poolId, msg.sender, r.actualGross, r.tokensOut);

        // The curve is exhausted when tokensSold reaches CURVE_SUPPLY. Graduate
        // on that, NOT on `refund > 0`: an exact-fill buy (newUsdcReserve lands
        // exactly at the cap) and the cap-branch ceil-clip both fill the curve
        // with refund == 0, and gating on refund would leave the launch
        // permanently stuck at the cap (every later buy reverts ZeroAmount, so
        // _graduate becomes unreachable and the AMM pool is never seeded).
        if (ArcadeV4Curve.isGraduated(state.tokensSold)) _graduate(token, state);

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
        if (r.usdcOut < minUsdcOut) revert Slippage();

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
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata /*hookData*/
    ) external override onlyPoolManager returns (bytes4, int128) {
        PoolId poolId = key.toId();
        CurveState memory state = curveStates[poolId];

        // Curving / GraduationStarted: nothing to do. Curving fees are taken
        // in hook.buy / hook.sell; GraduationStarted swaps revert in
        // beforeSwap before reaching here.
        if (state.status != uint8(Status.Graduated)) {
            return (IHooks.afterSwap.selector, int128(0));
        }

        // CLANKER: fee is the pool's native LP fee (no hook take, no PUMP
        // oracle). The only hook action is the first-window anti-snipe buy cap.
        if (state.mode == uint8(LaunchMode.CLANKER)) {
            _enforceClankerBuyCap(key, params, delta);
            return (IHooks.afterSwap.selector, int128(0));
        }

        // Identify the unspecified currency and the magnitude swapped through
        // it. Matches the V4 FeeTakingHook pattern: fee taken on the side
        // V4 hook deltas can affect cleanly. For Arcade this means royalty
        // is in token for USDC -> token buys and in USDC for token -> USDC
        // sells. Creators / treasury auto-convert on the token side via the
        // MultiSwap aggregator when needed.
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);

        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;
        if (swapAmount == 0) {
            _updateFeeObs(poolId, usdcIsCurrency0); // keep the oracle live
            return (IHooks.afterSwap.selector, int128(0));
        }

        // Always-USDC fee guarantee. afterSwap can only take on the UNSPECIFIED
        // side, so it takes iff USDC is the unspecified currency (buy exact-out
        // = spend USDC input; sell exact-in = receive USDC output). When USDC
        // is the specified side, beforeSwap already took the fee. Exactly one
        // path fires per swap, so the fee is never double-charged. Either way we
        // still advance the price oracle so the dynamic fee keeps tracking mcap.
        if (Currency.unwrap(feeCurrency) != Currency.unwrap(USDC)) {
            _updateFeeObs(poolId, usdcIsCurrency0);
            return (IHooks.afterSwap.selector, int128(0));
        }

        uint256 amount = uint256(uint128(swapAmount));

        // The hook captures the WHOLE trading fee (the pool LP fee is 0), split
        // 80/20 creator/treasury. feeBps is mode-driven (PUMP: mcap-decaying;
        // CLANKER: the creator-chosen tier). Hard-clamped for immutable safety.
        uint256 feeBps = _feeBps(state.mode, poolId);
        if (feeBps > MAX_TOTAL_TAKE_BPS) feeBps = MAX_TOTAL_TAKE_BPS;
        uint256 fee = (amount * feeBps) / 10_000;

        // Anti-sniper auction top-up: during the decay window post-grad, BUYS
        // pay an additional skim that goes to the CREATOR. Only USDC -> token
        // swaps count as buys. Sits ALONGSIDE the fee, same unspecified USDC side.
        uint256 snipeSkim = 0;
        if (_isUsdcToTokenSwap(key, params, USDC)) {
            address launchToken =
                Currency.unwrap(key.currency0) == Currency.unwrap(USDC)
                    ? Currency.unwrap(key.currency1)
                    : Currency.unwrap(key.currency0);
            uint256 bps = _currentSnipeBps(launchToken);
            if (bps > 0) snipeSkim = (amount * bps) / 10_000;
        }

        // Combined hard cap: fee + snipe can never exceed MAX_TOTAL_TAKE_BPS of
        // the swap (v4-core bricks the swap at 100%). Clamp the SNIPE down first
        // (the fee is the creator's core revenue), never revert -- a reverting
        // afterSwap would brick every swap on an immutable pool.
        uint256 maxTake = (amount * MAX_TOTAL_TAKE_BPS) / 10_000;
        if (fee > maxTake) fee = maxTake;
        if (fee + snipeSkim > maxTake) snipeSkim = maxTake - fee;
        _payAntiSnipe(poolId, feeCurrency, snipeSkim, amount);

        _distributeFee(poolId, feeCurrency, fee, state.mode, true);

        // Advance the price oracle AFTER taking the fee, so this swap's own
        // price impact never influences the fee it just paid.
        _updateFeeObs(poolId, usdcIsCurrency0);

        // Return the total taken on the unspecified side so the swapper pays.
        uint256 totalTaken = fee + snipeSkim;
        return (IHooks.afterSwap.selector, int128(int256(totalTaken)));
    }

    /// @dev Route anti-sniper auction proceeds to the launch CREATOR. The
    ///      anti-sniper is a descending-tax dutch auction on the first
    ///      post-graduation buys; the premium a sniper pays for early access
    ///      accrues to the creator/community (Clanker's model), not the
    ///      protocol -- it turns extractable sniping into creator revenue and
    ///      removes any protocol incentive to keep the tax high. Blocklist-safe
    ///      (a hostile creator recipient credits a pending pull, never bricks
    ///      the swap). No-op when the skim is zero.
    function _payAntiSnipe(PoolId poolId, Currency currency, uint256 snipeSkim, uint256 amount) internal {
        if (snipeSkim == 0) return;
        _safeTake(currency, feeOwners[poolId].creator, snipeSkim);
        emit AntiSnipeApplied(poolId, msg.sender, snipeSkim, uint16((snipeSkim * 10_000) / amount));
    }

    /// @dev Split `fee` (already computed, in `feeCurrency`) 80/20
    ///      creator/treasury and route it via _safeTake. The creator cut
    ///      flows through the optional creator2 split (CLANKER only) and the
    ///      Twitter-escrow slot when wired, falling back to a direct creator
    ///      take if the escrow reverts. Every take is blocklist-safe so a
    ///      hostile recipient credits a pending pull instead of bricking the
    ///      swap (CSEC-001). Shared by before/afterSwap so the split is
    ///      identical no matter which side USDC lands on.
    ///      `allowEscrow` gates the Twitter-escrow route: true for USDC fees
    ///      (the escrow pins one token per slot = USDC); false for a CLANKER
    ///      collect's TOKEN-side fee, which always goes direct to the creator.
    function _distributeFee(PoolId poolId, Currency feeCurrency, uint256 fee, uint8 mode, bool allowEscrow)
        internal
    {
        if (fee == 0) return;
        FeeOwner memory fo = feeOwners[poolId];
        uint256 creatorCut = (fee * POST_GRAD_CREATOR_BPS) / 10_000;
        uint256 treasuryCut = fee - creatorCut;

        // Optional creator2 split (CLANKER only, when configured).
        if (fo.creator2 != address(0) && fo.creator2Bps > 0 && mode == uint8(LaunchMode.CLANKER)) {
            uint256 creator2Cut = (creatorCut * fo.creator2Bps) / 10_000;
            if (creator2Cut > 0) {
                _safeTake(feeCurrency, fo.creator2, creator2Cut);
                creatorCut -= creator2Cut;
            }
        }

        // Route the creator cut. Twitter-escrow slot if the launch attributed
        // fees to a handle (USDC only), else direct to the creator.
        if (creatorCut > 0) {
            if (allowEscrow && fo.twitterEscrow != address(0)) {
                address feeTokenAddr = Currency.unwrap(feeCurrency);
                uint256 positionId = _positionIdForEscrow(poolId);
                // Deliver the USDC to the escrow FIRST, then credit the slot.
                // The escrow verifies delivery with a balance-diff, so crediting
                // before the transfer would always fail; delivering first means
                // a credit can never book more than actually arrived (no
                // books-exceed-balance drain across slots).
                _safeTake(feeCurrency, fo.twitterEscrow, creatorCut);
                try IArcadeTwitterEscrowV3Min(fo.twitterEscrow).creditSlot(
                    positionId, fo.slotIndex, feeTokenAddr, creatorCut
                ) {
                    // credited to the handle slot
                } catch {
                    // Misconfig (hook not allow-listed as a crediter) or the
                    // take pended: the USDC sits at the escrow un-earmarked
                    // (rescuable by the escrow owner) or in this hook's pending
                    // ledger. Never lost; surfaced for ops via the event. (The
                    // escrow's creditSlot is deliberately NOT pausable, so an
                    // escrow pause never routes fees through this path.)
                    emit EscrowCreditFailed(positionId, fo.slotIndex, creatorCut);
                }
            } else {
                _safeTake(feeCurrency, fo.creator, creatorCut);
            }
        }
        if (treasuryCut > 0) _safeTake(feeCurrency, TREASURY, treasuryCut);

        emit RoyaltyPaid(poolId, fo.creator, creatorCut, treasuryCut, Currency.unwrap(feeCurrency));
    }

    /// @dev The trading-fee rate (bps) for a graduated pool, by mode. PUMP uses
    ///      an mcap-decaying dynamic fee driven by the price EMA; CLANKER uses
    ///      the creator-chosen tier stored at launch (slice 3 wires selection;
    ///      for now tier 1 = 1%). Reads ONLY stored oracle state, never the
    ///      current swap's price, so a swap can't move the fee it itself pays.
    function _feeBps(uint8 mode, PoolId poolId) internal view returns (uint256) {
        if (mode != uint8(LaunchMode.PUMP)) {
            // CLANKER: the creator's chosen static tier. Fall back to tier 1 if
            // somehow unset (defensive; createLaunch always sets it for CLANKER).
            uint16 tier = feeOwners[poolId].feeTierBps;
            return tier == 0 ? FEE_TIER_1 : tier;
        }

        FeeObs storage o = feeObs[poolId];
        // Un-seeded (shouldn't happen post-graduation) -> charge the max.
        if (!o.init) return PUMP_FEE_MAX_BPS;

        int256 emaTick = int256(o.emaTickE3) / 1_000;
        int256 growth = emaTick - int256(o.gradMcapTick); // ticks of mcap growth
        if (growth <= 0) return PUMP_FEE_MAX_BPS; // at/below graduation mcap
        if (growth >= PUMP_FEE_FLOOR_TICKS) return PUMP_FEE_MIN_BPS; // matured

        // Linear decay in log-mcap from MAX at graduation to MIN at the floor.
        uint256 drop =
            (uint256(PUMP_FEE_MAX_BPS - PUMP_FEE_MIN_BPS) * uint256(growth)) / uint256(PUMP_FEE_FLOOR_TICKS);
        return uint256(PUMP_FEE_MAX_BPS) - drop;
    }

    /// @dev Map a CLANKER fee-tier selector (1/2/3) to its bps (100/200/300).
    ///      Reverts on any other value so a launch can't be created with an
    ///      out-of-range or zero tier.
    function _resolveFeeTierBps(uint8 tier) internal pure returns (uint16) {
        if (tier == 1) return FEE_TIER_1;
        if (tier == 2) return FEE_TIER_2;
        if (tier == 3) return FEE_TIER_3;
        revert InvalidFeeTier();
    }

    /// @dev The pool's current "mcap tick": the slot0 tick sign-normalised so it
    ///      RISES with market cap regardless of whether USDC is currency0 or
    ///      currency1. slot0.tick is log-price of currency1 per currency0; when
    ///      USDC is currency0 that price FALLS as the token appreciates, so we
    ///      negate it. Reads live pool state (post-swap when called in afterSwap).
    function _mcapTick(PoolId poolId, bool usdcIsCurrency0) internal view returns (int24) {
        (, int24 tick,,) = POOL_MANAGER.getSlot0(poolId);
        return usdcIsCurrency0 ? -tick : tick;
    }

    /// @dev Advance the price EMA toward the current mcap tick. Manipulation
    ///      resistance: (1) at most one update per block timestamp (dt==0 skips),
    ///      so an intra-block spike + revert never moves the oracle; (2) the
    ///      per-update weight is capped at 50% (dt clamped to TAU) so even a long
    ///      quiet gap can't snap the EMA to a single manipulated print; (3) the
    ///      FEE always reads the PRE-update EMA (callers update AFTER taking the
    ///      fee), so a swap never influences the fee it itself pays.
    function _updateFeeObs(PoolId poolId, bool usdcIsCurrency0) internal {
        FeeObs storage o = feeObs[poolId];
        if (!o.init) return; // only graduated pools carry an oracle
        uint32 nowTs = uint32(block.timestamp);
        uint256 dt = nowTs > o.lastTs ? uint256(nowTs - o.lastTs) : 0;
        if (dt == 0) return; // one update per timestamp

        int256 spotE3 = int256(_mcapTick(poolId, usdcIsCurrency0)) * 1_000;
        int256 ema = int256(o.emaTickE3);
        uint256 wdt = dt > EMA_TAU_SECONDS ? EMA_TAU_SECONDS : dt; // cap weight at 50%
        // ema += (spot - ema) * wdt / (wdt + TAU)
        ema += ((spotE3 - ema) * int256(wdt)) / int256(wdt + EMA_TAU_SECONDS);
        o.emaTickE3 = int64(ema);
        o.lastTs = nowTs;
    }

    /// @dev Revert a CLANKER buy whose token output tops the first-window
    ///      anti-snipe cap (clankerMaxBuyBps of TOTAL_SUPPLY within
    ///      clankerCapWindowSecs of launch). The single-sided CLANKER pool
    ///      can't carry a take-based tax, so this revert is its only block-0
    ///      snipe defense. Sells and post-window buys pass through.
    function _enforceClankerBuyCap(PoolKey calldata key, SwapParams calldata params, BalanceDelta delta) internal {
        uint16 capBps = clankerMaxBuyBps;
        if (capBps == 0) return;
        if (!_isUsdcToTokenSwap(key, params, USDC)) return; // buys only
        bool usdcIs0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        address token = usdcIs0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        uint64 launchedAt = clankerPos[token].launchedAt;
        if (block.timestamp >= uint256(launchedAt) + clankerCapWindowSecs) return; // window elapsed
        int128 tokenDelta = usdcIs0 ? delta.amount1() : delta.amount0();
        uint256 tokensOut = tokenDelta < 0 ? uint256(uint128(-tokenDelta)) : uint256(uint128(tokenDelta));

        // CUMULATIVE per block: a batch of sub-cap swaps in one tx all land in
        // the same block, so accumulating defeats atomic split-buying (the
        // per-swap cap alone was ~100% bypassable via multi-swap batching).
        BlockBuy storage bb = clankerBlockBuy[token];
        uint256 acc = (bb.blockNumber == uint64(block.number)) ? uint256(bb.bought) : 0;
        acc += tokensOut;
        if (acc > (ArcadeV4Curve.TOTAL_SUPPLY * capBps) / 10_000) revert BuyExceedsCap();
        bb.blockNumber = uint64(block.number);
        bb.bought = uint192(acc);
    }

    /// @dev True iff the swap routes USDC -> launch token (a buy).
    function _isUsdcToTokenSwap(PoolKey calldata key, SwapParams calldata params, Currency usdcCurrency)
        internal
        pure
        returns (bool)
    {
        address usdcAddr = Currency.unwrap(usdcCurrency);
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == usdcAddr;
        // zeroForOne == true means swap currency0 for currency1.
        return (usdcIsCurrency0 && params.zeroForOne) || (!usdcIsCurrency0 && !params.zeroForOne);
    }

    /// @dev positionId passed to the Twitter escrow's creditSlot. The escrow
    ///      treats this as opaque so we just use the PoolId as the identifier
    ///      (unique per launch, stable for the life of the pool).
    function _positionIdForEscrow(PoolId poolId) internal pure returns (uint256) {
        return uint256(PoolId.unwrap(poolId));
    }

    /// @dev Internal copy of currentSnipeBps that avoids an external self-call.
    function _currentSnipeBps(address token) internal view returns (uint256) {
        SnipeConfig memory cfg = snipeConfigs[token];
        if (cfg.startBps == 0 || cfg.decaySeconds == 0 || cfg.launchedAt == 0) return 0;
        uint256 elapsed = block.timestamp - cfg.launchedAt;
        if (elapsed >= cfg.decaySeconds) return 0;
        return (uint256(cfg.startBps) * (cfg.decaySeconds - elapsed)) / cfg.decaySeconds;
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

    // -------------------------------------------------------------------
    // Graduation
    // -------------------------------------------------------------------

    /// @dev Atomic curve -> AMM migration. Triggered from `buy` when the
    ///      simulateBuy result reports a refund > 0 (cap path).
    ///
    ///      Sequence (frozen per V4_HOOK_SPEC.md Section 5):
    ///        1. Status flip to GraduationStarted so any other in-flight call
    ///           sees the transient state and reverts cleanly.
    ///        2. Take MIGRATION_FEE (2_500 USDC) off the top to TREASURY.
    ///        3. Compute the V4 init price from the seed reserves.
    ///        4. Initialise the V4 pool at that price.
    ///        5. Unlock the manager and add full-range LP via `unlockCallback`.
    ///        6. Status flip to Graduated. The buy that triggered graduation
    ///           returns normally to the caller after this completes.
    /// @dev CLANKER direct launch: initialise the V4 pool at the starting market
    ///      cap and seed the FULL supply as a SINGLE-SIDED locked position (all
    ///      token, 0 USDC). No bonding curve -- buyers push the price up from the
    ///      start FDV. The hook owns the position (locked like the graduation
    ///      seed). The pool is Graduated (fee-capturing) from the first swap.
    ///      Single-sided orientation: the launch token sits entirely on its side
    ///      of the current tick so it is released (sold for USDC) only as the
    ///      price rises -- token=currency0 -> position [startTick, maxTick];
    ///      token=currency1 -> position [minTick, startTick].
    function _launchDirect(address token, PoolKey memory key, PoolId poolId, uint256 startMcap) internal {
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        uint256 supply = ArcadeV4Curve.TOTAL_SUPPLY;

        // Start price = FDV `startMcap` over the full supply. Same amount->price
        // convention as _graduate (USDC amount in the USDC currency slot).
        (uint256 amount0, uint256 amount1) =
            usdcIsCurrency0 ? (startMcap, supply) : (supply, startMcap);
        uint160 startSqrt = ArcadeV4Math.sqrtPriceX96FromAmounts(amount0, amount1);
        POOL_MANAGER.initialize(key, startSqrt);

        // Align the start tick so the full-supply position sits ENTIRELY on the
        // launch token's side of the current price (never straddling, which
        // would need USDC the hook doesn't hold). token=currency1 -> [minTick,
        // edge]; token=currency0 -> [edge, maxTick]. (See ArcadeV4Math.)
        int24 spacing = key.tickSpacing;
        int24 aligned = ArcadeV4Math.seedEdgeTick(startSqrt, spacing, usdcIsCurrency0);
        (int24 minT, int24 maxT) = ArcadeV4Math.fullRange(spacing);

        // Record the exact position range so collectFees can address it later
        // (modifyLiquidity keys the position by its tick range).
        uint64 nowTs = uint64(block.timestamp);
        if (usdcIsCurrency0) {
            clankerPos[token] = ClankerPos({tickLower: minT, tickUpper: aligned, seeded: true, launchedAt: nowTs});
        } else {
            clankerPos[token] = ClankerPos({tickLower: aligned, tickUpper: maxT, seeded: true, launchedAt: nowTs});
        }

        POOL_MANAGER.unlock(abi.encode(uint8(1), token, supply, uint256(0), aligned));

        // CLANKER uses the native pool LP fee (no PUMP oracle). Anti-sniper clock
        // was stamped at createLaunch (the pool is live now).
        emit Graduated(poolId, 0, supply);
    }

    function _graduate(address token, CurveState storage state) internal {
        state.status = uint8(Status.GraduationStarted);

        uint256 totalUsdc = state.realUsdcReserve;
        uint256 lpUsdc = ArcadeV4Curve.graduationLiquidityUsdc(totalUsdc);
        if (lpUsdc == 0) revert ZeroAmount();
        uint256 lpTokens = ArcadeV4Curve.MIGRATION_LP_TOKENS;

        // Migration fee off the top -> treasury. Via pull-payment escape so
        // a USDC-blocked treasury can't DoS graduation; the value still
        // lands, just sits in pendingTokenWithdrawals until pulled.
        _safePayUsdc(TREASURY, ArcadeV4Curve.MIGRATION_FEE);

        PoolKey memory key = _buildPoolKey(token);
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
        (uint256 amount0, uint256 amount1) =
            usdcIsCurrency0 ? (lpUsdc, lpTokens) : (lpTokens, lpUsdc);

        // The V4 init price MUST match the reserve ratio or the AMM will
        // start in an arb-able state and our LP gets one-sided.
        uint160 sqrtPriceX96 = ArcadeV4Math.sqrtPriceX96FromAmounts(amount0, amount1);
        POOL_MANAGER.initialize(key, sqrtPriceX96);

        // Hand off to the unlock callback which adds the LP + settles both
        // sides (kind 0 = graduation, full-range two-sided). The hook owns the
        // LP position; no external surface can remove it (beforeRemoveLiquidity
        // + noSelfCall), so it is permanently locked.
        POOL_MANAGER.unlock(abi.encode(uint8(0), token, amount0, amount1, int24(0)));

        state.status = uint8(Status.Graduated);

        // Start the anti-sniper decay clock NOW: the AMM pool goes live at
        // graduation, so this is the first moment afterSwap can tax a buy.
        // (createLaunch deliberately left launchedAt == 0.) Only touch it if a
        // config exists (startBps > 0); an unconfigured token stays untaxed.
        if (snipeConfigs[token].startBps > 0) {
            snipeConfigs[token].launchedAt = uint64(block.timestamp);
        }

        // Seed the PUMP fee oracle at the graduation price. The pool is now
        // initialised + seeded, so slot0 reads the graduation tick. The EMA
        // starts AT the graduation mcap tick, so the very first post-grad swaps
        // pay PUMP_FEE_MAX (1%); the fee only decays as the EMA climbs.
        PoolId pid = key.toId();
        int24 gmt = _mcapTick(pid, usdcIsCurrency0);
        feeObs[pid] = FeeObs({
            emaTickE3: int64(int256(gmt) * 1_000),
            gradMcapTick: gmt,
            lastTs: uint32(block.timestamp),
            init: true
        });

        emit Graduated(pid, totalUsdc, lpTokens);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (uint8 kind, address token, uint256 amount0, uint256 amount1, int24 startTick) =
            abi.decode(data, (uint8, address, uint256, uint256, int24));

        PoolKey memory key = _buildPoolKey(token);
        int24 spacing = key.tickSpacing;

        // kind 2 = CLANKER fee harvest. modifyLiquidity with delta=0 realises the
        // LP fees accrued to the locked position (returned as `feesAccrued`,
        // positive to the hook). Split each currency 80/20: USDC via the
        // escrow-aware path, the launch token direct to the creator.
        if (kind == 2) {
            ClankerPos memory pos = clankerPos[token];
            (, BalanceDelta feesAccrued) = POOL_MANAGER.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: pos.tickLower,
                    tickUpper: pos.tickUpper,
                    liquidityDelta: 0,
                    salt: bytes32(0)
                }),
                ""
            );
            PoolId poolId = key.toId();
            uint8 mode = curveStates[poolId].mode;
            bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
            uint256 fee0 = feesAccrued.amount0() > 0 ? uint256(uint128(feesAccrued.amount0())) : 0;
            uint256 fee1 = feesAccrued.amount1() > 0 ? uint256(uint128(feesAccrued.amount1())) : 0;
            // USDC side -> escrow-aware; token side -> creator-direct (escrow
            // pins one token per slot = USDC).
            if (usdcIsCurrency0) {
                _distributeFee(poolId, key.currency0, fee0, mode, true); // USDC
                _distributeFee(poolId, key.currency1, fee1, mode, false); // token
            } else {
                _distributeFee(poolId, key.currency0, fee0, mode, false); // token
                _distributeFee(poolId, key.currency1, fee1, mode, true); // USDC
            }
            emit FeeHarvested(PoolId.unwrap(poolId), fee0, fee1);
            return "";
        }

        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;

        if (kind == 0) {
            // Graduation: full-range two-sided position at the reserve ratio.
            (tickLower, tickUpper) = ArcadeV4Math.fullRange(spacing);
            uint160 sqrtPriceX96 = ArcadeV4Math.sqrtPriceX96FromAmounts(amount0, amount1);
            liquidity = ArcadeV4Math.liquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1);
        } else {
            // CLANKER direct: SINGLE-SIDED position of the full supply (amount0),
            // all on the launch token's side of `startTick`, so no USDC is
            // needed. token=currency0 -> [startTick, maxTick] (all currency0);
            // token=currency1 -> [minTick, startTick] (all currency1).
            bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(USDC);
            uint256 supply = amount0;
            (int24 minT, int24 maxT) = ArcadeV4Math.fullRange(spacing);
            if (usdcIsCurrency0) {
                // launch token = currency1: position below the start.
                tickLower = minT;
                tickUpper = startTick;
                liquidity = ArcadeV4Math.liquidityForAmount1(tickLower, tickUpper, supply);
            } else {
                // launch token = currency0: position above the start.
                tickLower = startTick;
                tickUpper = maxT;
                liquidity = ArcadeV4Math.liquidityForAmount0(tickLower, tickUpper, supply);
            }
        }

        (BalanceDelta callerDelta,) = POOL_MANAGER.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // Settle each side the hook owes (negative delta). For the direct seed
        // only the token side is owed (USDC delta is 0), so this naturally
        // settles single-sided.
        int128 d0 = callerDelta.amount0();
        int128 d1 = callerDelta.amount1();
        if (d0 < 0) _settleSide(key.currency0, uint256(uint128(-d0)));
        if (d1 < 0) _settleSide(key.currency1, uint256(uint128(-d1)));

        return "";
    }

    /// @dev Pay `amount` of `currency` to the PoolManager, balancing the
    ///      modifyLiquidity delta.
    function _settleSide(Currency currency, uint256 amount) internal {
        if (amount == 0) return;
        POOL_MANAGER.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(POOL_MANAGER), amount);
        POOL_MANAGER.settle();
    }

    /// @dev Canonical PoolKey for a launch. Sorts the currencies by address
    ///      so currency0 < currency1 (v4 invariant), then sets the hook to
    ///      this contract.
    ///      POOL FEE = 0: the pool itself charges NOTHING. The hook captures
    ///      the entire trading fee in before/afterSwap (always in USDC, split
    ///      80/20 creator/treasury). A nonzero pool LP fee would accrue into
    ///      the hook's locked position with no collect surface (dead value);
    ///      taking it in the hook pays the creator per-swap instead. tickSpacing
    ///      200 unchanged.
    function _buildPoolKey(address launchToken) internal view returns (PoolKey memory key) {
        address usdcAddr = Currency.unwrap(USDC);
        (Currency c0, Currency c1) = usdcAddr < launchToken
            ? (USDC, Currency.wrap(launchToken))
            : (Currency.wrap(launchToken), USDC);
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: poolFeeOf[launchToken], // 0 for PUMP (hook captures), tier for CLANKER
            tickSpacing: 200,
            hooks: IHooks(address(this))
        });
    }

    /// @dev CLANKER fee tier (bps) -> V4 static LP fee units (1e6 = 100%).
    ///      100bps(1%)->10000, 200->20000, 300->30000.
    function _tierToV4Fee(uint16 tierBps) internal pure returns (uint24) {
        return uint24(tierBps) * 100;
    }

    /// @dev PUMP curve fee split = 50/50 platform/creator. Only PUMP reaches
    ///      here: CLANKER launches are Graduated (buy/sell revert
    ///      LiquidityNotPermitted) and CLANKER_V3 is rejected at createLaunch,
    ///      so `mode` is always PUMP and the split is unconditional. Transfers
    ///      happen synchronously in USDC out of the hook's own balance, NOT via
    ///      pm.take, because curve fees are bookkept in the hook's accumulating
    ///      realUsdcReserve balance. Each payout goes through `_safePayUsdc` so
    ///      a USDC-blocked recipient credits a pending balance instead of
    ///      reverting the whole curve trade.
    function _distributeCurveFee(uint8 mode, uint256 fee, address creator, address creator2, uint16 creator2Bps)
        internal
    {
        if (fee == 0) return;
        // Silence unused-param warnings; the args are kept for call-site
        // symmetry with the post-grad path but PUMP has no creator2 curve cut.
        mode;
        creator2;
        creator2Bps;

        uint256 platformCut = fee / 2; // 50/50
        uint256 creatorCut = fee - platformCut;

        if (platformCut > 0) _safePayUsdc(TREASURY, platformCut);
        if (creatorCut > 0) _safePayUsdc(creator, creatorCut);
    }

    /// @dev Best-effort USDC payout from the hook's own balance. If the
    ///      transfer reverts or returns false (USDC blocklist, receiver
    ///      rejects, etc.) the amount is credited to
    ///      `pendingTokenWithdrawals[USDC][to]` instead. CSEC-001: keeps a
    ///      single blocked recipient from DOSing every curve trade or
    ///      graduation. The recipient pulls later via `claimPendingToken`.
    function _safePayUsdc(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        address usdcAddr = Currency.unwrap(USDC);
        try IERC20(usdcAddr).transfer(to, amount) returns (bool ok) {
            if (ok) return;
        } catch {
            // fall through to credit
        }
        pendingTokenWithdrawals[usdcAddr][to] += amount;
        emit TokenCredited(usdcAddr, to, amount);
    }

    /// @dev Best-effort PoolManager.take. If the recipient rejects the
    ///      transfer (USDC blocklist, contract receive hook revert, etc.)
    ///      the funds are taken to the hook instead and credited as a
    ///      pending pull-payment. CSEC-001 applied to the V4 royalty path.
    function _safeTake(Currency currency, address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        try POOL_MANAGER.take(currency, to, amount) {
            return;
        } catch {
            // Fall through: take to the hook, credit the recipient.
        }
        POOL_MANAGER.take(currency, address(this), amount);
        address tokenAddr = Currency.unwrap(currency);
        pendingTokenWithdrawals[tokenAddr][to] += amount;
        emit TokenCredited(tokenAddr, to, amount);
    }

}
