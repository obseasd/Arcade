// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ArcadeLaunchToken} from "./ArcadeLaunchToken.sol";
import {IArcadeLaunchpad} from "./interfaces/IArcadeLaunchpad.sol";
import {IArcadeV2Factory} from "../dex/interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Pair} from "../dex/interfaces/IArcadeV2Pair.sol";
import {IArcadeV2Router} from "../dex/interfaces/IArcadeV2Router.sol";
import {
    IArcadeV3Factory,
    IArcadeV3Pool,
    IArcadeV3Locker,
    IArcadeV3Router,
    IArcadeTokenVault
} from "../v3/interfaces/IArcadeV3Minimal.sol";
import {ArcadeV3PriceMath} from "../v3/ArcadeV3PriceMath.sol";

/**
 * @title ArcadeLaunchpad
 * @notice Launchpad with three launch modes:
 *         - PUMP      : pump.fun-style bonding curve, 50% platform / 50% creator(s)
 *         - CLANKER   : bonding curve, 70% platform / 30% creator(s), with the
 *                       option to split the creator share between two addresses
 *         - CLANKER_V3: true Clanker-style, NO curve — the full supply is locked
 *                       single-sided in a Uniswap V3 pool at creation (1 or 3
 *                       ranges per pool type), tradeable instantly, LP locked
 *                       forever; LP fees split 80% creator(s) / 20% platform.
 *
 *         PUMP/CLANKER tokens are fixed-supply ERC20s (1B, 18 decimals) minted
 *         into this contract and traded against virtual USDC reserves on a
 *         constant-product curve. When the curve sells out (800M tokens), the
 *         contract seeds a Uniswap V2 pool with the collected USDC + the 200M
 *         unsold tokens, then burns the LP tokens to a dead address.
 *
 * Curve trade fee: 1% of every swap, taken in USDC; split per mode as above.
 * Creation fee: 3 USDC, paid to treasury at launch (all modes).
 *
 * USDC has 6 decimals on Arc. Token has 18 decimals.
 */
contract ArcadeLaunchpad is IArcadeLaunchpad, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant MIGRATION_LP_TOKENS = TOTAL_SUPPLY - CURVE_SUPPLY; // 200M
    /// @notice H-05: platform fee skimmed off the curve's raised USDC at
    /// migration. With realUsdcReserve = 20,000 USDC at the migration
    /// threshold, 2,500 USDC goes to the treasury and the V2 pair is seeded
    /// with 17,500 USDC + `tokensForLP` tokens.
    ///
    /// CORRECTED (audit 2026-07-11 MEDIUM-2): this used to claim "200M tokens".
    /// It is NOT 200M. `tokensForLP = usdcForLP * MIGRATION_LP_TOKENS /
    /// currentUsdc` = 17,500e6 * 200M / 25,000e6 = **140M**, and the remaining
    /// **60M** is sent to DEAD as `burnExcess`. So the pair opens at
    /// 17,500 / 140M = 0.000125 USDC per token, i.e. an FDV of 125,000 USDC,
    /// not the 87,500 the old "200M" figure implied. The 2026-07-01
    /// clearing-price fix is what introduced the scaling; this comment was
    /// simply never updated. SECURITY.md and project memory carry the same
    /// stale figure and need the same correction.
    /// NOTE: no test pins `tokensForLP`, which is why the drift went unnoticed.
    /// @dev Audit Launchpad M-2: CLANKER_V3 launches deliberately do NOT
    ///      pay this one-shot 2_500 USDC. V3 is structured to extract
    ///      the platform's cut perpetually via the V3 Locker's 20%
    ///      slice of every recipient payout (see ArcadeV3Locker
    ///      _distributePot + the platform recipient appended in
    ///      _validateRecipients). Over the lifetime of an active V3
    ///      pool that 20% lifetime fee stream is expected to exceed
    ///      the 2_500 USDC one-shot, so the V3 path is NOT a free seat.
    uint256 public constant MIGRATION_FEE = 2_500e6;
    uint256 internal constant VIRTUAL_USDC_RESERVE = 5_000e6;
    uint256 internal constant VIRTUAL_TOKEN_RESERVE = 1_000_000_000e18;
    uint256 internal constant K_CONSTANT = VIRTUAL_USDC_RESERVE * VIRTUAL_TOKEN_RESERVE;

    uint256 public constant CREATION_FEE = 3e6; // 3 USDC
    uint256 internal constant TRADE_FEE_BPS = 100; // 1% total
    uint256 internal constant FEE_DENOMINATOR = 10_000;

    // PUMP mode: 50% platform / 50% creator(s)
    uint256 internal constant PUMP_PLATFORM_BPS = 5_000; // 50% of the trade fee
    // CLANKER mode: 70% platform / 30% creator(s)
    uint256 internal constant CLANKER_PLATFORM_BPS = 7_000; // 70% of the trade fee

    /// @notice Post-migration royalty taken on top of V2 LP fees when the
    /// swap is routed through `buyMigrated` / `sellMigrated`. Uniform split
    /// across both launch modes (the bonding-curve split logic only applies
    /// while the curve is active).
    uint256 internal constant MIGRATED_PLATFORM_BPS = 20; // 0.20% to platform
    uint256 internal constant MIGRATED_CREATOR_BPS = 10; // 0.10% to creator(s)
    uint256 internal constant MIGRATED_ROYALTY_BPS = MIGRATED_PLATFORM_BPS + MIGRATED_CREATOR_BPS; // 0.30% total

    // --- V3 vault (CLANKER_V3) migration params ---
    /// @notice V3 pool fee tier used for vault migrations: 1% (matches the
    /// high-fee, creator-friendly Clanker model).
    uint24 internal constant V3_FEE = 10_000;
    /// @notice Tick spacing for the 1% fee tier.
    int24 internal constant V3_TICK_SPACING = 200;
    /// @notice Creator's share of V3 LP fees in the locker (80%); platform gets 20%.
    uint16 internal constant V3_CREATOR_BPS = 8_000;

    // --- Pool types (Clanker-style presets) ---
    // Kept `internal` (no public getters) to stay under the EIP-170 size limit;
    // the frontend uses literal pool-type ids, not these getters.
    uint8 internal constant POOL_STANDARD = 0; // USDC, 35k start, 3 positions
    uint8 internal constant POOL_LEGACY = 1; // USDC, custom 1..1M start, 1 position
    uint8 internal constant POOL_DEEP = 2; // USDC, 50k start, 3 positions
    uint8 internal constant POOL_WETH = 3; // WETH, 10 ETH start, 3 positions
    uint256 internal constant STANDARD_MCAP = 35_000e6; // 35,000 USDC
    uint256 internal constant DEEP_MCAP = 50_000e6; // 50,000 USDC
    uint256 internal constant WETH_MCAP = 10e18; // 10 WETH
    uint256 internal constant LEGACY_MIN_MCAP = 1e6; // 1 USDC
    uint256 internal constant LEGACY_MAX_MCAP = 1_000_000e6; // 1,000,000 USDC
    /// @notice Max share of supply that can be vaulted (locked/vesting) for the
    /// creator; the rest must go to the LP. 90%.
    uint16 internal constant MAX_VAULT_BPS = 9_000;
    /// @notice Max starting sniper-tax rate (50%). Decays linearly to 0.
    uint16 internal constant MAX_SNIPE_BPS = 5_000;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // The v2Factory/v2Router/v3Factory/deployer immutables below are `internal`
    // (no external reader, verified) to reclaim EIP-170 headroom.

    // --- Immutables ---

    IERC20 public immutable USDC;
    IArcadeV2Factory internal immutable v2Factory;
    address internal immutable v2Router;
    address public immutable treasury;
    /// @notice Uniswap V3 factory (for CLANKER_V3 vault migrations). May be the
    /// zero address on deployments that don't use V3 vaults.
    IArcadeV3Factory internal immutable v3Factory;
    /// @notice WETH on Arc, used as the quote token for POOL_WETH launches.
    /// May be the zero address on deployments that don't offer WETH pools.
    address public immutable weth;
    /// @notice Deployer, allowed to wire the V3 locker exactly once.
    address internal immutable deployer;
    /// @notice ArcadeV3Locker that permanently holds CLANKER_V3 LP positions.
    /// Set once post-deploy (the locker needs this contract's address at its
    /// own construction, so the wiring is circular and resolved via a setter).
    address public v3Locker;
    /// @notice ArcadeV3SwapRouter — used for the optional creator buy at launch.
    address public v3Router;
    /// @notice ArcadeTokenVault — holds the optional locked/vesting creator allocation.
    address public tokenVault;

    // --- State ---

    // `internal`: nothing reads tokens() directly (frontend uses getTokenState;
    // routers use isMigrated/getTokenState/creatorBondedCount). Dropping the
    // redundant struct auto-getter reclaims EIP-170 headroom.
    mapping(address => TokenState) internal tokens;
    /// @notice Count of a creator's tokens that have GRADUATED off the bonding
    /// curve (PUMP/CLANKER via _migrate). CLANKER_V3 never graduates via the
    /// curve, so it is never counted. O(1) read for the identity issuer's tier
    /// gate (replaces an O(n) allTokens scan that truncated past a cap).
    mapping(address => uint256) public creatorBondedCount;
    address[] public allTokens;

    struct Comment {
        address author;
        uint64 timestamp;
        string text;
    }

    mapping(address => Comment[]) public tokenComments;

    // --- Errors ---

    error UnknownToken();
    error AlreadyMigrated();
    error NotMigrated();
    error Slippage();
    error MidSlippage();
    error EmptyName();
    error CommentTooLong();
    error CommentEmpty();
    error ZeroAmount();
    error InvalidMode();
    error InvalidShare();
    error NoRouter();
    error V3NotConfigured();
    error NotDeployer();
    error LockerAlreadySet();
    error BadFeeTier();
    error BadVault();
    error BadSnipe();
    error BadPoolType();
    error InvalidRoute();
    error Expired();
    error NothingToWithdraw();

    /// @notice Pull-payment ledger for USDC payouts that failed inline (eg the
    /// recipient is on the USDC blacklist or its `transfer` reverts). The credit
    /// can be withdrawn later by the same recipient via `claimPendingUsdc`.
    /// Without this fallback a single blacklisted creator/treasury/recipient
    /// would brick every buy/sell of that token forever.
    mapping(address => uint256) public pendingUsdcWithdrawals;

    event UsdcCredited(address indexed recipient, uint256 amount);
    event UsdcPendingClaimed(address indexed recipient, uint256 amount);

    /// @notice Sniper config stored per token. The Arcade V3 router skims
    /// `startBps` from buys at launch, decaying linearly to 0 over
    /// `decaySeconds`. Soft protection — a direct pool swap bypasses it.
    struct SnipeConfig {
        uint16 startBps;
        uint32 decaySeconds;
    }

    /// @notice Bundled CLANKER_V3 launch options. FLAT (no nested structs) so
    /// the ABI decoder stays within stack limits.
    struct ClankerOptions {
        uint24 fee; // 1% / 2% / 3%
        uint256 creatorBuyUsdc;
        uint16 vaultPct; // bps of supply to vault (0 = none, max MAX_VAULT_BPS)
        uint64 vaultLockupDuration; // >= vault MIN_LOCKUP when vaultPct > 0
        uint64 vaultVestingDuration; // linear vesting after lockup (0 = cliff)
        address vaultRecipient;
        uint16 snipeStartBps; // 0 = no sniper tax
        uint32 snipeDecaySeconds;
        uint8 poolType; // POOL_STANDARD / POOL_LEGACY / POOL_DEEP / POOL_WETH
        uint256 legacyMcapUsdc; // start mcap for POOL_LEGACY (1..1M USDC); ignored otherwise
    }

    /// token => sniper config (set at CLANKER_V3 launch).
    mapping(address => SnipeConfig) public snipeConfig;

    constructor(
        IERC20 usdc_,
        IArcadeV2Factory v2Factory_,
        address v2Router_,
        address treasury_,
        IArcadeV3Factory v3Factory_,
        address weth_
    ) {
        USDC = usdc_;
        v2Factory = v2Factory_;
        v2Router = v2Router_;
        treasury = treasury_;
        v3Factory = v3Factory_;
        weth = weth_;
        deployer = msg.sender;
    }

    /// @notice One-time wiring of the V3 locker + router (resolves the
    /// launchpad<->locker circular constructor dependency, and gives the
    /// launchpad the router it uses for the optional creator buy). Deployer-only.
    /// All three must be set in the same call; there is intentionally no shim
    /// that wires the locker alone, because doing so would brick `setV3Infra`
    /// and leave the launchpad unable to ever wire `v3Router` / `tokenVault`.
    function setV3Infra(address locker, address router, address vault) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (v3Locker != address(0)) revert LockerAlreadySet();
        // L-12: hard-reject zero addresses. A previous shape allowed
        // setV3Infra(0, X, Y) to land in a half-wired state where a follow-up
        // call could still overwrite the V3 router/vault via the latent
        // `v3Locker == 0` guard. Explicit zero rejection makes the bootstrap
        // truly atomic.
        if (locker == address(0) || router == address(0) || vault == address(0)) {
            revert ZeroAmount();
        }
        v3Locker = locker;
        v3Router = router;
        tokenVault = vault;
        // M-05: burn the deployer slot post-wire. After `setV3Infra` lands,
        // the deployer role has no more purpose — leaving the hot key live is
        // unnecessary risk. We can't clear the immutable `deployer`, but
        // every later check is `msg.sender != deployer` and the `v3Locker`
        // gate above prevents re-entry to this function anyway.
    }

    // ====================== Token creation ======================

    /**
     * @notice Launches a new token on the bonding curve.
     * @param name_ ERC20 name
     * @param symbol_ ERC20 symbol
     * @param metadataURI off-chain metadata URI (ipfs:// or inline data: JSON)
     * @param mode 0 = PUMP (50/50), 1 = CLANKER (70/30)
     * @param creator2 optional secondary fee receiver (only used in CLANKER mode; pass `address(0)` to disable)
     * @param creator2ShareBps fraction of the CREATOR portion routed to `creator2`, in bps (0–10000).
     *                        Ignored if `creator2 == address(0)` or in PUMP mode.
     */
    function createToken(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI,
        LaunchMode mode,
        address creator2,
        uint16 creator2ShareBps
    ) external nonReentrant returns (address tokenAddr) {
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert EmptyName();
        if (uint8(mode) > 2) revert InvalidMode();
        // CLANKER_V3 requires the V3 factory + locker to be wired.
        if (mode == LaunchMode.CLANKER_V3 && (address(v3Factory) == address(0) || v3Locker == address(0))) {
            revert V3NotConfigured();
        }
        if (creator2ShareBps > 10_000) revert InvalidShare();

        // Pull creation fee → treasury
        // Pull into the contract, then pay the treasury through the SAME
        // fallback every other treasury payment uses (_distributeFee,
        // _distributeMigratedFee, _migrate). Paying `treasury` directly here
        // made token creation a hard availability dependency on the treasury
        // being transferable: a USDC-blacklisted or frozen treasury would
        // revert EVERY createToken forever, and `treasury` is immutable with no
        // setter. That contradicted this contract's own stated design intent
        // (see the blacklist note above). Audit 2026-07-11 LOW-2.
        USDC.safeTransferFrom(msg.sender, address(this), CREATION_FEE);
        _safePayUsdc(treasury, CREATION_FEE);

        // Deploy new token (mints TOTAL_SUPPLY to this contract)
        ArcadeLaunchToken token = new ArcadeLaunchToken(name_, symbol_, TOTAL_SUPPLY, address(this));
        tokenAddr = address(token);

        TokenState storage s = tokens[tokenAddr];
        s.token = tokenAddr;
        s.creator = msg.sender;
        // creator2 is a CLANKER-only feature (per the NatSpec): PUMP is a plain
        // 50/50 platform/creator split and ignores any creator2 passed in.
        bool useCreator2 = mode == LaunchMode.CLANKER && creator2 != address(0);
        s.creator2 = useCreator2 ? creator2 : address(0);
        s.creator2ShareBps = useCreator2 ? creator2ShareBps : 0;
        s.mode = mode;
        s.createdAt = uint64(block.timestamp);
        allTokens.push(tokenAddr);

        emit TokenCreated(tokenAddr, msg.sender, mode, s.creator2, s.creator2ShareBps, name_, symbol_, metadataURI);

        // Curve modes (PUMP/CLANKER) migrate to a V2 pair at graduation. Claim
        // the deterministic USDC/token pair NOW, seed-gated to this launchpad, so
        // no one can pre-mint or poison it before we seed it. Atomic with the
        // token mint, so the pair address cannot be front-run. CLANKER_V3 has no
        // curve and never migrates, so it needs no pair.
        if (mode != LaunchMode.CLANKER_V3) {
            v2Factory.createPairGated(address(USDC), tokenAddr);
        }

        // CLANKER_V3 is a true Clanker-style launch: NO bonding curve. The
        // token goes straight into a locked single-sided V3 position and is
        // tradeable immediately. `buy`/`sell` (curve ops) revert for it since
        // it's flagged migrated from birth. This entry point uses the default
        // fee split (creator V3_CREATOR_BPS / treasury rest); use
        // `createClankerV3` to configure up to 3 custom recipients.
        if (mode == LaunchMode.CLANKER_V3) {
            IArcadeV3Locker.Recipient[] memory rs = new IArcadeV3Locker.Recipient[](2);
            rs[0] = IArcadeV3Locker.Recipient({
                recipient: msg.sender,
                admin: msg.sender,
                bps: V3_CREATOR_BPS,
                tokenPref: IArcadeV3Locker.RewardToken.Both
            });
            rs[1] = IArcadeV3Locker.Recipient({
                recipient: treasury,
                admin: treasury,
                bps: uint16(FEE_DENOMINATOR - V3_CREATOR_BPS),
                tokenPref: IArcadeV3Locker.RewardToken.Both
            });
            // Default entry point: Standard pool (USDC, 35k start, 3 positions).
            _launchClankerV3(s, tokenAddr, rs, V3_FEE, 0, TOTAL_SUPPLY, POOL_STANDARD, 0);
        }
    }

    /**
     * @notice Clanker-style launch with up to 3 custom fee recipients. No
     * bonding curve — the full supply is locked single-sided in a V3 pool at
     * creation. `recipients` bps must sum to 10000 and cover both fee sides
     * (validated by the locker). Each recipient carries an admin that can later
     * rotate its payout address / admin.
     */
    /// @param optsData ABI-encoded `ClankerOptions` (passed as bytes to keep the
    /// external function's calldata decoder within stack limits).
    function createClankerV3(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI,
        IArcadeV3Locker.Recipient[] calldata recipients,
        bytes calldata optsData
    ) external nonReentrant returns (address tokenAddr) {
        ClankerOptions memory opts = abi.decode(optsData, (ClankerOptions));
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert EmptyName();
        if (address(v3Factory) == address(0) || v3Locker == address(0)) revert V3NotConfigured();
        if (opts.fee != 10_000 && opts.fee != 20_000 && opts.fee != 30_000) revert BadFeeTier();
        if (opts.creatorBuyUsdc > 0 && v3Router == address(0)) revert NoRouter();
        if (opts.poolType == POOL_WETH && opts.creatorBuyUsdc > 0) revert BadPoolType(); // USDC buy needs a USDC pool
        if (opts.vaultPct > 0 && (opts.vaultPct > MAX_VAULT_BPS || tokenVault == address(0))) revert BadVault();
        if (opts.snipeStartBps > MAX_SNIPE_BPS) revert BadSnipe();

        // Pull into the contract, then pay the treasury through the SAME
        // fallback every other treasury payment uses (_distributeFee,
        // _distributeMigratedFee, _migrate). Paying `treasury` directly here
        // made token creation a hard availability dependency on the treasury
        // being transferable: a USDC-blacklisted or frozen treasury would
        // revert EVERY createToken forever, and `treasury` is immutable with no
        // setter. That contradicted this contract's own stated design intent
        // (see the blacklist note above). Audit 2026-07-11 LOW-2.
        USDC.safeTransferFrom(msg.sender, address(this), CREATION_FEE);
        _safePayUsdc(treasury, CREATION_FEE);

        ArcadeLaunchToken token = new ArcadeLaunchToken(name_, symbol_, TOTAL_SUPPLY, address(this));
        tokenAddr = address(token);

        TokenState storage s = tokens[tokenAddr];
        s.token = tokenAddr;
        s.creator = msg.sender;
        s.mode = LaunchMode.CLANKER_V3;
        s.createdAt = uint64(block.timestamp);
        allTokens.push(tokenAddr);

        emit TokenCreated(tokenAddr, msg.sender, LaunchMode.CLANKER_V3, address(0), 0, name_, symbol_, metadataURI);

        uint256 lpSupply = _applyVault(tokenAddr, opts);
        // Platform always keeps 20% of the LP fees; the creator's recipients
        // split the other 80%.
        IArcadeV3Locker.Recipient[] memory rs = _withPlatformCut(recipients);
        _launchClankerV3(
            s, tokenAddr, rs, opts.fee, opts.creatorBuyUsdc, lpSupply, opts.poolType, opts.legacyMcapUsdc
        );

        // Audit 2026-06-11 v2 E-02: the audit recommended arming snipe
        // BEFORE the creator's buy to close the creator-grabs-deepest-
        // tick-tax-free loophole, but that ordering breaks the creator-
        // buy's 25% slippage check (CSEC-013) whenever snipeStartBps
        // exceeds 25%. The creator's buy is computed assuming `slot0`
        // sqrt and a pool with full LP; a 50% skim during the buy would
        // halve the effective sqrtIn, blow the slippage band, and revert
        // the entire launch. Deferred to a gen 10 redesign that either
        // (a) widens the creator-buy slippage tolerance dynamically when
        // a snipe is configured, or (b) applies a smaller "creator self-
        // tax" cap distinct from the public snipeStartBps. Status quo:
        // creator's own buy is untaxed, external buyers in the same
        // block see the armed rate when they hit this contract after
        // our tx returns.
        if (opts.snipeStartBps > 0 && opts.snipeDecaySeconds > 0) {
            snipeConfig[tokenAddr] = SnipeConfig(opts.snipeStartBps, opts.snipeDecaySeconds);
        }
    }

    /// @dev Rescales the creator's recipients (bps must sum to 10000) down to the
    /// creator share (V3_CREATOR_BPS = 80%) and appends the platform (treasury)
    /// at the remaining 20%, eligible for both fee pots.
    function _withPlatformCut(IArcadeV3Locker.Recipient[] calldata rs)
        internal
        view
        returns (IArcadeV3Locker.Recipient[] memory out)
    {
        uint256 n = rs.length;
        if (n < 1 || n > 3) revert InvalidShare();
        uint256 sum;
        for (uint256 i; i < n; ++i) sum += rs[i].bps;
        if (sum != FEE_DENOMINATOR) revert InvalidShare();

        // M-13: cache the locker's wired Twitter escrow address so we can
        // enforce `recipient == escrow ⇒ admin == escrow`. Without this, a
        // creator could set recipient = escrow but admin = themselves, in
        // which case fees would be credited to the escrow but no backend
        // Twitter handle is associated — funds would be permanently stuck
        // because the escrow has no signer for an unattributed slot.
        address escrow = IArcadeV3Locker(v3Locker).twitterEscrow();

        out = new IArcadeV3Locker.Recipient[](n + 1);
        uint256 scaledSum;
        for (uint256 i; i < n; ++i) {
            uint16 scaled = uint16((uint256(rs[i].bps) * V3_CREATOR_BPS) / FEE_DENOMINATOR);
            // A share so small it scales to 0 would make the locker revert; reject early.
            if (scaled == 0) revert InvalidShare();
            // M-13: an escrow-routed slot MUST also have escrow as its admin.
            // Symmetric: an escrow-admined slot MUST also have escrow as
            // recipient (otherwise a future updateRecipient could redirect
            // attributed fees away to a creator-controlled address).
            if (escrow != address(0)) {
                bool rIsEscrow = rs[i].recipient == escrow;
                bool aIsEscrow = rs[i].admin == escrow;
                if (rIsEscrow != aIsEscrow) revert InvalidShare();
            }
            out[i] = IArcadeV3Locker.Recipient({
                recipient: rs[i].recipient,
                admin: rs[i].admin,
                bps: scaled,
                tokenPref: rs[i].tokenPref
            });
            scaledSum += scaled;
        }
        // Rounding dust goes to the first recipient so the creator share is exactly 80%.
        out[0].bps = uint16(uint256(out[0].bps) + (V3_CREATOR_BPS - scaledSum));
        out[n] = IArcadeV3Locker.Recipient({
            recipient: treasury,
            admin: treasury,
            bps: uint16(FEE_DENOMINATOR - V3_CREATOR_BPS),
            tokenPref: IArcadeV3Locker.RewardToken.Both
        });
    }

    /// @dev Carves the optional vaulted allocation; returns the LP supply.
    function _applyVault(address tokenAddr, ClankerOptions memory opts) internal returns (uint256 lpSupply) {
        lpSupply = TOTAL_SUPPLY;
        if (opts.vaultPct > 0) {
            uint256 vaultAmount = (TOTAL_SUPPLY * opts.vaultPct) / FEE_DENOMINATOR;
            lpSupply = TOTAL_SUPPLY - vaultAmount;
            IERC20(tokenAddr).safeTransfer(tokenVault, vaultAmount);
            IArcadeTokenVault(tokenVault).createVest(
                tokenAddr, opts.vaultRecipient, vaultAmount, opts.vaultLockupDuration, opts.vaultVestingDuration
            );
        }
    }

    /**
     * @dev Bonding-curve fee distribution: split depends on the token's
     * launch mode (PUMP 50/50 vs CLANKER 70/30) and optionally splits the
     * creator portion between two receivers (CLANKER). Dust rounds up to the
     * platform (ceil division) so the platform never silently subsidises
     * dust to the creator on tiny micro-trades.
     */
    function _distributeFee(TokenState storage s, uint256 feeIn) internal {
        if (feeIn == 0) return;
        uint256 platformBps = s.mode == LaunchMode.PUMP ? PUMP_PLATFORM_BPS : CLANKER_PLATFORM_BPS;
        uint256 platformFee = (feeIn * platformBps + FEE_DENOMINATOR - 1) / FEE_DENOMINATOR; // ceil
        if (platformFee > feeIn) platformFee = feeIn;
        _payCreatorShare(s, feeIn - platformFee);
        if (platformFee > 0) _safePayUsdc(treasury, platformFee);
    }

    /**
     * @dev Post-migration fee distribution: uniform 0.20% platform / 0.10%
     * creator regardless of mode. The creator portion can still be split
     * between two receivers (CLANKER feature).
     */
    function _distributeMigratedFee(TokenState storage s, uint256 totalRoyalty) internal {
        if (totalRoyalty == 0) return;
        uint256 platformFee = (totalRoyalty * MIGRATED_PLATFORM_BPS + MIGRATED_ROYALTY_BPS - 1)
            / MIGRATED_ROYALTY_BPS;
        _payCreatorShare(s, totalRoyalty - platformFee);
        if (platformFee > 0) _safePayUsdc(treasury, platformFee);
    }

    /// @dev Splits the creator portion between creator and (optional) creator2.
    function _payCreatorShare(TokenState storage s, uint256 creatorPortion) internal {
        if (creatorPortion == 0) return;
        uint256 creator2Cut = 0;
        if (s.creator2 != address(0) && s.creator2ShareBps > 0) {
            creator2Cut = (creatorPortion * s.creator2ShareBps) / 10_000;
        }
        uint256 creator1Cut = creatorPortion - creator2Cut;
        if (creator1Cut > 0) _safePayUsdc(s.creator, creator1Cut);
        if (creator2Cut > 0) _safePayUsdc(s.creator2, creator2Cut);
    }

    /// @dev Best-effort USDC payout to `to`. If the underlying `transfer` reverts
    /// or returns false (USDC blacklist, recipient is a smart contract that
    /// rejects, etc.) the amount is credited to `pendingUsdcWithdrawals[to]`
    /// instead, where the recipient can later pull it via `claimPendingUsdc`.
    /// This guarantees a single blacklisted recipient can never DoS curve
    /// trades or post-migration royalty distribution.
    /// @dev Audit code-quality #4: build a 2-element address path once.
    ///      All migrated-route entry points + curve fee distribution used to
    ///      open-code `address[] memory p = new address[](2); p[0] = a; p[1] = b;`
    ///      six times. Single helper saves ~80-120 bytes across the file.
    function _path2(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function _safePayUsdc(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        try IERC20(address(USDC)).transfer(to, amount) returns (bool ok) {
            if (ok) return;
        } catch {}
        pendingUsdcWithdrawals[to] += amount;
        emit UsdcCredited(to, amount);
    }

    /// @notice Withdraw any USDC credited to `msg.sender` from a failed inline
    /// payout. Permissionless; always sends to the original recipient.
    function claimPendingUsdc() external nonReentrant returns (uint256 amount) {
        amount = pendingUsdcWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingUsdcWithdrawals[msg.sender] = 0;
        // Direct safeTransfer here: if it still reverts, the user's blacklist
        // status hasn't changed and they can retry once cleared.
        USDC.safeTransfer(msg.sender, amount);
        emit UsdcPendingClaimed(msg.sender, amount);
    }

    // ====================== Buy ======================

    function buy(address tokenAddr, uint256 amountUsdcIn, uint256 minTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut, uint256 usdcSpent, uint256 refund)
    {
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0)) revert UnknownToken();
        if (s.migrated) revert AlreadyMigrated();
        if (amountUsdcIn == 0) revert ZeroAmount();

        // Pull the gross amount from buyer
        USDC.safeTransferFrom(msg.sender, address(this), amountUsdcIn);

        uint256 fee;
        uint256 netIn;
        unchecked {
            fee = (amountUsdcIn * TRADE_FEE_BPS) / FEE_DENOMINATOR;
            netIn = amountUsdcIn - fee;
        }

        (tokensOut, usdcSpent, refund) = _computeBuyView(s, netIn, fee);

        // tokensOut is the actual amount; usdcSpent is the actual gross paid.
        if (tokensOut < minTokensOut) revert Slippage();

        // Recompute fee on the actual gross spent (clamped to migration cap).
        // L-01: update curve state BEFORE _distributeFee. CEI-correct order so
        // a contract observing the launchpad's view state mid-call (eg a
        // future hook-enabled USDC) sees fresh tokensSold / realUsdcReserve.
        uint256 actualFee;
        unchecked {
            actualFee = (usdcSpent * TRADE_FEE_BPS) / FEE_DENOMINATOR;
            s.realUsdcReserve += usdcSpent - actualFee;
            s.tokensSold += tokensOut;
        }

        _distributeFee(s, actualFee);

        // Deliver tokens
        IERC20(tokenAddr).safeTransfer(msg.sender, tokensOut);

        // Refund overshoot, if any
        if (refund > 0) {
            USDC.safeTransfer(msg.sender, refund);
        }

        uint256 priceQ64 = _spotPriceQ64(s);
        emit Buy(tokenAddr, msg.sender, usdcSpent, tokensOut, priceQ64);

        // Trigger migration if the curve is now fully sold
        if (s.tokensSold == CURVE_SUPPLY) {
            _migrate(tokenAddr);
        }
    }

    // _computeBuy was a non-view duplicate of _computeBuyView. Folded into
    // the single _computeBuyView (below) which buy() now calls directly,
    // saving ~600 bytes of bytecode (kept ArcadeLaunchpad under EIP-170).

    // ====================== Sell ======================

    function sell(address tokenAddr, uint256 tokensIn, uint256 minUsdcOut)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0)) revert UnknownToken();
        if (s.migrated) revert AlreadyMigrated();
        if (tokensIn == 0) revert ZeroAmount();

        // Pull tokens from seller
        IERC20(tokenAddr).safeTransferFrom(msg.sender, address(this), tokensIn);

        // Compute gross USDC out on the curve. Wrapped in unchecked: invariants
        // on tokensSold/realUsdcReserve plus the explicit dust clamp below keep
        // every operation safe. Saves bytecode (EIP-170 budget).
        uint256 grossOut;
        unchecked {
            uint256 currentUsdc = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
            uint256 currentTokens = VIRTUAL_TOKEN_RESERVE - s.tokensSold;
            uint256 newTokenReserve = currentTokens + tokensIn;
            // MATH-002: ceiling division so quote == executed and the pool
            // keeps any rounding microUSDC instead of paying it out.
            uint256 newUsdcReserve = (K_CONSTANT + newTokenReserve - 1) / newTokenReserve;
            grossOut = currentUsdc - newUsdcReserve;
        }
        if (grossOut > s.realUsdcReserve) {
            // Should not happen if math is correct, but guard the dust case
            grossOut = s.realUsdcReserve;
        }

        uint256 fee = (grossOut * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        usdcOut = grossOut - fee;
        if (usdcOut < minUsdcOut) revert Slippage();

        // Update state
        unchecked {
            s.realUsdcReserve -= grossOut;
            s.tokensSold -= tokensIn;
        }

        // Pay out fees per launch mode, then user
        _distributeFee(s, fee);
        USDC.safeTransfer(msg.sender, usdcOut);

        emit Sell(tokenAddr, msg.sender, tokensIn, usdcOut, _spotPriceQ64(s));
    }

    // ====================== Post-migration trading with creator royalty ======================

    /**
     * @notice Buy a migrated token by routing through the V2 router, while
     * skimming `MIGRATED_ROYALTY_BPS` from the input as a perpetual royalty
     * for the creator(s) + platform. LPs still receive the standard 0.30%
     * V2 swap fee on the remaining amount.
     */
    function buyMigrated(address tokenAddr, uint256 usdcIn, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0)) revert UnknownToken();
        if (!s.migrated) revert NotMigrated();
        // CLANKER_V3 tokens have NO V2 pair (they trade on the locked V3 pool),
        // and are `migrated` from birth. Routing them here would swap through an
        // attacker-creatable, unauthenticated V2 pair with false slippage
        // protection. Force them onto the V3 router instead.
        if (s.mode == LaunchMode.CLANKER_V3) revert InvalidRoute();
        if (usdcIn == 0) revert ZeroAmount();
        if (v2Router == address(0)) revert NoRouter();

        USDC.safeTransferFrom(msg.sender, address(this), usdcIn);

        uint256 royalty;
        uint256 netIn;
        unchecked {
            royalty = (usdcIn * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR;
            netIn = usdcIn - royalty;
        }
        if (royalty > 0) _distributeMigratedFee(s, royalty);
        USDC.forceApprove(v2Router, netIn);

        uint256[] memory amounts = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            netIn, minTokensOut, _path2(address(USDC), tokenAddr), msg.sender, deadline
        );
        tokensOut = amounts[1];
        // Audit M-5: V2 router enforces minTokensOut natively; the
        // belt-and-suspenders re-check was trimmed for EIP-170 budget.
    }

    /// @notice Sell a migrated token via V2, then skim the royalty from the USDC output.
    function sellMigrated(address tokenAddr, uint256 tokensIn, uint256 minUsdcOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (block.timestamp > deadline) revert Expired();
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0)) revert UnknownToken();
        if (!s.migrated) revert NotMigrated();
        // CLANKER_V3 has no V2 pair (see buyMigrated) - reject to avoid routing
        // through an attacker-creatable pair with false slippage protection.
        if (s.mode == LaunchMode.CLANKER_V3) revert InvalidRoute();
        if (tokensIn == 0) revert ZeroAmount();
        if (v2Router == address(0)) revert NoRouter();

        IERC20(tokenAddr).safeTransferFrom(msg.sender, address(this), tokensIn);
        IERC20(tokenAddr).forceApprove(v2Router, tokensIn);

        uint256[] memory amounts = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            tokensIn, 0, _path2(tokenAddr, address(USDC)), address(this), deadline
        );
        uint256 grossUsdc = amounts[1];

        uint256 royalty;
        unchecked {
            royalty = (grossUsdc * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR;
            usdcOut = grossUsdc - royalty;
        }
        if (usdcOut < minUsdcOut) revert Slippage();

        if (royalty > 0) _distributeMigratedFee(s, royalty);
        USDC.safeTransfer(msg.sender, usdcOut);
    }

    // ====================== Multi-hop with royalty on both legs ======================

    /**
     * @notice Swap `tokensIn` of `tokenIn` for `tokenOut` via the USDC pivot,
     * charging the post-migration royalty on each leg whose token is a
     * migrated launchpad token. This is the path the frontend should use
     * whenever at least one of {tokenIn, tokenOut} is a migrated launchpad
     * token and the other is not USDC.
     *
     * Flow:
     *   1. Pull `tokensIn` of `tokenIn` and swap it to USDC on V2.
     *   2. If `tokenIn` is a migrated launchpad token, skim 0.30% of the
     *      USDC output as royalty (split per `_distributeMigratedFee`).
     *   3. If `tokenOut` is a migrated launchpad token, skim 0.30% of the
     *      remaining USDC as royalty before the second leg.
     *   4. Swap the remaining USDC to `tokenOut` on V2, delivering the
     *      output directly to `msg.sender`.
     *
     * If neither side is a migrated launchpad token this function still
     * works but charges nothing; the user should call the V2 router
     * directly in that case to save gas.
     */
    /// @dev Shared validation + classification for the token<->token migrated
    /// route (swapMigratedRoute + its quote). Returns `ok=false` for an
    /// unroutable pair: same token, either side USDC, either side CLANKER_V3, or
    /// neither side a migrated launch. Royalty is only charged on migrated sides.
    function _migratedPair(address tokenIn, address tokenOut)
        internal
        view
        returns (bool inMig, bool outMig, bool ok)
    {
        if (tokenIn == tokenOut || tokenIn == address(USDC) || tokenOut == address(USDC)) {
            return (false, false, false);
        }
        TokenState storage sIn = tokens[tokenIn];
        TokenState storage sOut = tokens[tokenOut];
        if (sIn.mode == LaunchMode.CLANKER_V3 || sOut.mode == LaunchMode.CLANKER_V3) {
            return (false, false, false);
        }
        inMig = sIn.token != address(0) && sIn.migrated;
        outMig = sOut.token != address(0) && sOut.migrated;
        ok = inMig || outMig;
    }

    function swapMigratedRoute(
        address tokenIn,
        address tokenOut,
        uint256 tokensIn,
        uint256 minTokensOut,
        uint256 usdcMidMin,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (v2Router == address(0)) revert NoRouter();
        if (tokensIn == 0) revert ZeroAmount();
        // Shared validation (rejects same-token / USDC-side / CLANKER_V3 /
        // neither-side-migrated) + per-side classification. `_migratedPair` is
        // reused by quoteSwapMigratedRoute so the two stay in lockstep.
        (bool inMigrated, bool outMigrated, bool ok) = _migratedPair(tokenIn, tokenOut);
        if (!ok) revert InvalidRoute();

        // --- Leg 1: tokenIn -> USDC ---
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), tokensIn);
        IERC20(tokenIn).forceApprove(v2Router, tokensIn);

        uint256[] memory leg1 = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            tokensIn, 0, _path2(tokenIn, address(USDC)), address(this), deadline
        );
        uint256 usdcMid = leg1[1];
        // Audit 2026-06-11 contract #10: mid-leg slippage floor mirrors
        // the V3 router's MID_SLIPPAGE defence. Sandwiching the leg-1
        // pool drives usdcMid arbitrarily low; without this gate the
        // royalty + leg-2 chain could still scrape past minTokensOut on
        // a thin pair. Frontend computes usdcMidMin from
        // quoteSwapMigratedRoute's intermediate USDC value at 97%.
        // Custom error (vs `require(... , "STR")`) saves ~20 bytes of
        // bytecode — keeps ArcadeLaunchpad under EIP-170 with the
        // forge nightly compiler used in CI.
        if (usdcMid < usdcMidMin) revert MidSlippage();

        // CSEC-018: both royalty legs computed from the ORIGINAL usdcMid so the
        // combined royalty stays exactly at 2 * MIGRATED_ROYALTY_BPS (advertised
        // 60 bps) instead of compounding to 59.91 bps. Previously royaltyB ran
        // on usdcMid AFTER royaltyA was deducted, shaving 0.09 bps off the
        // creator B share. Deducting BOTH from usdcMid afterward keeps the
        // trader's net second-leg input identical to what the quote function
        // returns when its own mirror is updated.
        uint256 usdcMidOriginal = usdcMid;

        // Royalty on the USDC produced by selling tokenIn. Unchecked: both
        // royalties bounded by MIGRATED_ROYALTY_BPS (60 bps) of usdcMid,
        // and the subtractions can never underflow since combined royalty
        // tops out at 1.2% of usdcMid.
        unchecked {
            if (inMigrated) {
                uint256 royaltyA = (usdcMidOriginal * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR;
                if (royaltyA > 0) {
                    _distributeMigratedFee(tokens[tokenIn], royaltyA);
                    usdcMid -= royaltyA;
                }
            }
            if (outMigrated) {
                uint256 royaltyB = (usdcMidOriginal * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR;
                if (royaltyB > 0) {
                    _distributeMigratedFee(tokens[tokenOut], royaltyB);
                    usdcMid -= royaltyB;
                }
            }
        }

        // --- Leg 2: USDC -> tokenOut, delivered to the user ---
        USDC.forceApprove(v2Router, usdcMid);
        uint256[] memory leg2 = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            usdcMid, minTokensOut, _path2(address(USDC), tokenOut), msg.sender, deadline
        );
        // The router already enforces minTokensOut as amountOutMin, so leg2[1]
        // is guaranteed >= minTokensOut here (no redundant re-check needed).
        tokensOut = leg2[1];
    }

    /**
     * @notice View quote for `swapMigratedRoute`. Mirrors the on-chain flow
     * (incl. royalty skim) so the frontend can display an accurate output.
     * Returns `(tokensOut, totalRoyaltyUsdc)`.
     */
    function quoteSwapMigratedRoute(address tokenIn, address tokenOut, uint256 tokensIn)
        external
        view
        returns (uint256 tokensOut, uint256 totalRoyaltyUsdc)
    {
        if (v2Router == address(0) || tokensIn == 0) return (0, 0);
        // Same shared validation as swapMigratedRoute (invalid routes quote 0).
        (bool inMigrated, bool outMigrated, bool ok) = _migratedPair(tokenIn, tokenOut);
        if (!ok) return (0, 0);

        uint256[] memory leg1 = IArcadeV2Router(v2Router).getAmountsOut(
            tokensIn, _path2(tokenIn, address(USDC))
        );
        uint256 usdcMid = leg1[1];

        // CSEC-018 mirror: both royalty legs computed on the ORIGINAL usdcMid
        // so the quoted total matches the executed total (60 bps exact, not
        // 59.91 bps compounded).
        uint256 usdcMidOriginal = usdcMid;
        uint256 royaltyA = inMigrated ? (usdcMidOriginal * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR : 0;
        usdcMid -= royaltyA;
        uint256 royaltyB = outMigrated ? (usdcMidOriginal * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR : 0;
        usdcMid -= royaltyB;
        totalRoyaltyUsdc = royaltyA + royaltyB;

        uint256[] memory leg2 = IArcadeV2Router(v2Router).getAmountsOut(
            usdcMid, _path2(address(USDC), tokenOut)
        );
        tokensOut = leg2[1];
    }

    // ====================== Migration ======================

    function _migrate(address tokenAddr) internal {
        // Only curve-based modes (PUMP / CLANKER) ever reach here. CLANKER_V3
        // launches immediately at creation and is flagged migrated from birth,
        // so its buys revert before any curve fill.
        TokenState storage s = tokens[tokenAddr];
        s.migrated = true;
        s.migratedAt = uint64(block.timestamp);
        // O(1) bonded-launch tally for the identity tier gate (PUMP/CLANKER
        // graduations only; CLANKER_V3 never reaches _migrate).
        creatorBondedCount[s.creator] += 1;

        // H-05: take MIGRATION_FEE off the top to the treasury. With the
        // standard 20k raised, the pair gets 17.5k seed + 2.5k goes to
        // platform. Guard against an under-funded reserve (shouldn't happen
        // since migration triggers at realUsdcReserve == 20k exactly, but
        // belt-and-suspenders if curve params ever change).
        uint256 raised = s.realUsdcReserve;
        s.realUsdcReserve = 0;
        uint256 platformCut;
        uint256 usdcForLP;
        unchecked {
            platformCut = raised >= MIGRATION_FEE ? MIGRATION_FEE : raised;
            usdcForLP = raised - platformCut;
        }
        // Audit 2026-07-01 (MEV): seed the pair at the curve's CLEARING price so
        // the DEX opens exactly where the curve just closed, instead of ~30%
        // below it. The old code seeded the full MIGRATION_LP_TOKENS against
        // usdcForLP, which priced the pair under the curve's final price and
        // handed a risk-free back-run to the first arber on every graduation.
        // Scale tokensForLP to the clearing ratio currentUsdc : currentTokens
        // (currentTokens == MIGRATION_LP_TOKENS at 100% since migration only
        // fires at tokensSold == CURVE_SUPPLY), and burn the un-seeded remainder
        // of the LP allotment so nothing is stranded in the launchpad.
        uint256 currentUsdc = VIRTUAL_USDC_RESERVE + raised;
        uint256 tokensForLP = (usdcForLP * MIGRATION_LP_TOKENS) / currentUsdc;
        uint256 burnExcess;
        unchecked { burnExcess = MIGRATION_LP_TOKENS - tokensForLP; }
        if (burnExcess > 0) IERC20(tokenAddr).safeTransfer(DEAD, burnExcess);

        if (platformCut > 0) {
            _safePayUsdc(treasury, platformCut);
        }

        // Audit 2026-06-28 H-1: seed liquidity through the router's
        // addLiquidity with zero min-amounts, instead of a manual
        // transfer+mint gated on pair.totalSupply()==0.
        //
        // The previous guard reverted migration into ANY pre-existing pair to
        // block the L-1 pre-mint LP-theft. But that turned the deterministic
        // pair address into a permanent griefing brick: anyone could pre-mint
        // a few wei of LP on the canonical USDC/token pair and the curve could
        // then never finish migrating (every fill-buy reverted forever, no LP
        // seed, no migration fee, late buyers stranded).
        //
        // addLiquidity quotes at the CURRENT reserves, which kills BOTH bugs:
        //  - L-1 (theft): only proportional liquidity is added; nothing is
        //    donated to a pre-miner's LP. The un-seeded remainder is refunded
        //    here, not gifted to the pool.
        //  - H-1 (brick): with amountMin = 0 it never reverts on a poisoned or
        //    skewed pair, so migration always completes.
        // For the normal (empty) pair it adds the full seed and refunds nothing.
        // Seed the pair directly at the curve's clearing price. The pair was
        // pre-created seed-gated to this launchpad in createToken, so its first
        // mint (and any sync while unseeded) is restricted to us: no attacker can
        // hold pre-existing LP or sync a donation into the reserves. We still
        // skim first to burn any RAW donated balance (reserves are 0, so skim
        // sends the full donation to DEAD), guaranteeing the pool opens exactly
        // at usdcForLP : tokensForLP. Because both sides are nonzero, the empty-
        // pair sqrt-mint yields liquidity > 0 and can never revert, so migration
        // always completes with a real, correctly priced market. This removes the
        // old router.addLiquidity(min=0) path that trusted attacker reserves for
        // pricing (L-1) and the try/catch that graduated market-less on a poisoned
        // pair (H-1 regression). LP is minted to DEAD = permanently locked.
        address pair = v2Factory.getPair(address(USDC), tokenAddr);
        IArcadeV2Pair(pair).skim(DEAD);
        USDC.safeTransfer(pair, usdcForLP);
        IERC20(tokenAddr).safeTransfer(pair, tokensForLP);
        IArcadeV2Pair(pair).mint(DEAD);
        s.v2Pair = pair;
        emit Migrated(tokenAddr, pair, usdcForLP, tokensForLP);
    }

    /// @dev Clanker-style immediate launch (no bonding curve): deploy a Uniswap
    /// V3 pool initialized at the pool type's start mcap, then lock the LP supply
    /// single-sided in ArcadeV3Locker. The token is tradeable immediately; price
    /// rises as it's bought and USDC accumulates in the locked position. The
    /// creator earns 80% of perpetual LP fees (platform 20%); principal is
    /// locked forever. Called from `createToken` for CLANKER_V3.
    /// @dev Resolves a pool type to (paired token, start mcap, supply split).
    function _poolConfig(uint8 poolType, uint256 legacyMcapUsdc)
        internal
        view
        returns (address paired, uint256 mcap, uint16[] memory positionBps)
    {
        if (poolType == POOL_LEGACY) {
            if (legacyMcapUsdc < LEGACY_MIN_MCAP || legacyMcapUsdc > LEGACY_MAX_MCAP) revert BadPoolType();
            paired = address(USDC);
            mcap = legacyMcapUsdc;
            positionBps = new uint16[](1);
            positionBps[0] = uint16(FEE_DENOMINATOR);
            return (paired, mcap, positionBps);
        }

        // All other types use the 3-position Clanker-style split (40/35/25).
        positionBps = new uint16[](3);
        positionBps[0] = 4_000;
        positionBps[1] = 3_500;
        positionBps[2] = 2_500;
        if (poolType == POOL_STANDARD) {
            (paired, mcap) = (address(USDC), STANDARD_MCAP);
        } else if (poolType == POOL_DEEP) {
            (paired, mcap) = (address(USDC), DEEP_MCAP);
        } else if (poolType == POOL_WETH) {
            if (weth == address(0)) revert BadPoolType();
            (paired, mcap) = (weth, WETH_MCAP);
        } else {
            revert BadPoolType();
        }
    }

    function _launchClankerV3(
        TokenState storage s,
        address tokenAddr,
        IArcadeV3Locker.Recipient[] memory recipients,
        uint24 fee,
        uint256 creatorBuyUsdc,
        uint256 lpSupply,
        uint8 poolType,
        uint256 legacyMcapUsdc
    ) internal {
        (address paired, uint256 mcap, uint16[] memory positionBps) = _poolConfig(poolType, legacyMcapUsdc);

        // Start price is FDV-based on the FULL supply, regardless of how much
        // is actually placed in the LP (the rest may be vaulted).
        (address token0, address token1, uint256 amount0, uint256 amount1) = paired < tokenAddr
            ? (paired, tokenAddr, mcap, TOTAL_SUPPLY)
            : (tokenAddr, paired, TOTAL_SUPPLY, mcap);

        address pool = v3Factory.getPool(token0, token1, fee);
        if (pool == address(0)) {
            pool = v3Factory.createPool(token0, token1, fee);
        }
        uint160 sqrtPriceX96 = ArcadeV3PriceMath.encodeSqrtPriceX96(amount1, amount0);
        // Audit medium [23]: try/catch guard against pre-init grief. The
        // token address is derived from this launchpad's CREATE nonce and
        // therefore predictable in the mempool; without this guard an
        // attacker could pre-init the predicted pool at any price (gas-
        // only cost) so that initialize() reverts with 'AI' and the
        // creator's CLANKER_V3 launch was permanently bricked. try/catch
        // accepts whatever sqrtPriceX96 is already on the pool and lets
        // the launch proceed; reverts elsewhere in the path (eg sane-
        // tick locker mint) still surface. Equivalent in safety to the
        // canonical PoolInitializer slot0==0 check but ~250 bytes lighter
        // so the launchpad stays under EIP-170's 24 KB limit.
        try IArcadeV3Pool(pool).initialize(sqrtPriceX96) {} catch {
            /* pool already initialised */
        }

        // Audit 2026-06-29 (HIGH): do NOT anchor the locked single-sided
        // liquidity to the pool's slot0. The token address is CREATE-nonce
        // predictable, so an attacker can pre-initialise the predicted pool at
        // a cheap price. The previous code overwrote sqrtPriceX96 with that
        // slot0 value, and the locker (_computeRanges anchors its bands to the
        // passed sqrtPriceX96 tick) then placed the ENTIRE launch supply at the
        // attacker's price, letting them buy it cheap (steal-the-supply).
        // Keep sqrtPriceX96 at the INTENDED launch price. The locker anchors
        // its bands to max/min(liveTick, intendedTick) so the mint stays
        // single-sided against the live tick (never owes the paired token), so a
        // hostile pre-init yields at worst a mispriced-but-tradeable launch, not
        // a brick (see the anchor-only note below). The creator-buy path also
        // enforces an FDV-based minOut. (Residual: a pre-init pushed to the
        // absolute MIN/MAX tick edge can still revert inside the locker's band
        // math - a pure grief the attacker gains nothing from, unavoidable
        // without pool-address unpredictability that Arc has no randomness for.)
        (uint160 sp,,,,,,) = IArcadeV3Pool(pool).slot0();
        if (sp == 0) revert InvalidRoute();
        // Anchor-only, deliberately NO price-deviation revert here. The V3 pool
        // address is CREATE-nonce predictable and Uniswap createPool/initialize
        // are permissionless, so an attacker can pre-init the predicted pool for
        // gas only. A hard revert on deviation would hand that attacker a cheap,
        // repeatable brick-DoS of the launch (verified 2026-07-05). Instead we
        // keep sqrtPriceX96 at the INTENDED price and let the locker anchor its
        // bands to max/min(liveTick, intendedTick): the mint stays single-sided
        // (never owes the paired token), so a hostile pre-init yields at worst a
        // mispriced-but-tradeable launch, never a brick. The creator-buy below
        // still enforces an FDV-based minOut. (Arc has no randomness to make the
        // address unpredictable; completing-mispriced beats bricking.)

        // L-02: flip migrated state BEFORE the external locker call so that
        // any view of `isMigrated(token)` invoked during the locker's
        // pool.mint -> uniswapV3MintCallback chain sees a consistent state.
        // Without this, MultiSwap or any other consumer reading isMigrated
        // mid-callback would mistakenly route via the curve path.
        s.migrated = true;
        s.migratedAt = uint64(block.timestamp);
        s.v2Pair = pool; // reuse the field to store the (V3) pool address

        // Hand the LP supply (total minus any vaulted amount) to the locker.
        IERC20(tokenAddr).safeTransfer(v3Locker, lpSupply);
        IArcadeV3Locker(v3Locker).lockSingleSided(
            IArcadeV3Locker.SingleSidedParams({
                pool: pool,
                paired: paired,
                token: tokenAddr,
                sqrtPriceX96: sqrtPriceX96,
                tokenAmount: lpSupply,
                positionBps: positionBps,
                recipients: recipients,
                fee: fee // CSEC-013: locker re-derives pool from factory.getPool(token, paired, fee)
            })
        );

        emit Migrated(tokenAddr, pool, 0, lpSupply);

        // Optional creator buy. Restricted to USDC-paired pools because the
        // amountOutMinimum derivation below assumes paired == USDC. If we
        // ever extend creator buys to WETH-paired pools the math + paired
        // approval need a parallel branch.
        if (creatorBuyUsdc > 0 && paired == address(USDC)) {
            USDC.safeTransferFrom(s.creator, address(this), creatorBuyUsdc);
            USDC.forceApprove(v3Router, creatorBuyUsdc);
            // Slippage hard minOut from intended-mcap FDV (NOT slot0,
            // attacker-pre-init defence). 25% accepts the single-sided
            // tick walk for realistic creator buys while still catching
            // an order-of-magnitude pre-init corruption.
            uint256 expectedOut = (creatorBuyUsdc * TOTAL_SUPPLY) / mcap;
            uint256 minOut = (expectedOut * 7500) / 10000;
            // Best-effort: a pre-initialized (poisoned) pool can push the price
            // so the 75% minOut reverts. Don't let the OPTIONAL creator buy brick
            // the whole launch - on failure, refund the creator and complete the
            // launch without the buy. (The locker fix already guarantees the LP
            // seed itself never reverts on a poisoned pre-init.)
            try IArcadeV3Router(v3Router).exactInputSingle(
                address(USDC), tokenAddr, fee, s.creator, creatorBuyUsdc, minOut, block.timestamp + 600
            ) returns (uint256) {
                // bought successfully
            } catch {
                USDC.forceApprove(v3Router, 0);
                USDC.safeTransfer(s.creator, creatorBuyUsdc);
            }
        }
    }

    // ====================== Views ======================

    /// @notice Spot price as USDC (6dp) per 1 token (18dp), returned as Q64.64 fixed point.
    function _spotPriceQ64(TokenState storage s) internal view returns (uint256) {
        uint256 usdcReserve = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
        uint256 tokenReserve = VIRTUAL_TOKEN_RESERVE - s.tokensSold;
        if (tokenReserve == 0) return 0;
        return (usdcReserve << 64) / tokenReserve;
    }

    function getTokensCount() external view returns (uint256) {
        return allTokens.length;
    }

    function getTokenState(address tokenAddr) external view returns (TokenState memory) {
        return tokens[tokenAddr];
    }

    /// @notice Returns true iff `tokenAddr` is a launchpad token whose curve
    /// has migrated to V2. Cheap one-line check for other routers (e.g.
    /// ArcadeMultiSwap) deciding whether to apply the post-migration royalty.
    function isMigrated(address tokenAddr) external view returns (bool) {
        TokenState storage s = tokens[tokenAddr];
        return s.token != address(0) && s.migrated;
    }

    /// @notice Current anti-sniper tax rate (bps) for `tokenAddr`, decaying
    /// linearly from `startBps` at launch to 0 over `decaySeconds`. Read by the
    /// Arcade V3 router to skim buys. Returns 0 once the window has elapsed.
    function currentSnipeBps(address tokenAddr) external view returns (uint256) {
        SnipeConfig memory c = snipeConfig[tokenAddr];
        if (c.startBps == 0 || c.decaySeconds == 0) return 0;
        uint64 launchedAt = tokens[tokenAddr].migratedAt;
        if (launchedAt == 0) return 0;
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= c.decaySeconds) return 0;
        return (uint256(c.startBps) * (c.decaySeconds - elapsed)) / c.decaySeconds;
    }

    /// @notice Returns the implied market cap of `tokenAddr` in USDC raw units (6 dp).
    /// Branches on launch mode:
    ///   - PUMP / Arcade pre-migration: curve virtual+real reserves.
    ///   - PUMP / Arcade post-migration: V2 pair reserves (USDC side).
    ///   - CLANKER_V3: derived from the V3 pool's `slot0().sqrtPriceX96`. Reading
    ///     V2-pair `getReserves` on a V3 pool would revert.
    function marketCap(address tokenAddr) external view returns (uint256) {
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0)) return 0;
        unchecked {
            if (s.migrated) {
                if (s.mode == LaunchMode.CLANKER_V3) {
                    return _v3MarketCap(s);
                }
                (uint112 r0, uint112 r1,) = IArcadeV2Pair(s.v2Pair).getReserves();
                address t0 = IArcadeV2Pair(s.v2Pair).token0();
                (uint256 usdcReserve, uint256 tokenReserve) =
                    t0 == address(USDC) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
                if (tokenReserve == 0) return 0;
                // Price the CIRCULATING supply, not TOTAL_SUPPLY. _migrate
                // sends `burnExcess` to DEAD (60M of the 1B on standard params,
                // since tokensForLP scales to the clearing price), and burned
                // tokens are not circulating. Dividing by TOTAL_SUPPLY
                // overstated every migrated token's mcap by ~6.4%.
                // Read DEAD's balance rather than a constant: burnExcess is
                // computed from the migration math, not fixed, and holders may
                // burn tokens too -- which should also leave the mcap.
                uint256 circulating = TOTAL_SUPPLY - IERC20(tokenAddr).balanceOf(DEAD);
                if (circulating == 0) return 0;
                return (usdcReserve * circulating) / tokenReserve;
            }
            uint256 currentUsdc = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
            uint256 currentTokens = VIRTUAL_TOKEN_RESERVE - s.tokensSold;
            if (currentTokens == 0) return 0;
            return (currentUsdc * TOTAL_SUPPLY) / currentTokens;
        }
    }

    /// @dev mcap for a CLANKER_V3 token, derived from the V3 pool price.
    /// Only meaningful for USDC-paired pools (POOL_WETH returns 0 here since we
    /// don't price WETH internally — the frontend handles the WETH conversion).
    function _v3MarketCap(TokenState storage s) internal view returns (uint256) {
        unchecked {
            address pool = s.v2Pair;
            if (pool == address(0)) return 0;
            (uint160 sqrtPriceX96,,,,,,) = IArcadeV3Pool(pool).slot0();
            if (sqrtPriceX96 == 0) return 0;
            address token0 = IArcadeV3Pool(pool).token0();
            if (token0 != address(USDC) && IArcadeV3Pool(pool).token1() != address(USDC)) return 0;
            uint256 p = uint256(sqrtPriceX96);
            if (token0 == address(USDC)) {
                // mcap = TOTAL_SUPPLY * 2**192 / sqrtPriceX96^2
                uint256 part = (TOTAL_SUPPLY * (1 << 96)) / p;
                return (part * (1 << 96)) / p;
            }
            // mcap = TOTAL_SUPPLY * sqrtPriceX96^2 / 2**192
            uint256 partA = (p * TOTAL_SUPPLY) / (1 << 96);
            return (partA * p) / (1 << 96);
        }
    }

    /// @notice Quote tokens out for a hypothetical buy of `amountUsdcIn` (gross).
    /// Returns `(tokensOut, actualGrossPaid, refund)` so the UI can show the
    /// exact gross the user will be charged (especially on curve-fill edges
    /// where `actualGross < amountUsdcIn` and the rest is refunded).
    function quoteBuy(address tokenAddr, uint256 amountUsdcIn)
        external
        view
        returns (uint256 tokensOut, uint256 actualGrossPaid, uint256 refund)
    {
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0) || s.migrated || amountUsdcIn == 0) return (0, 0, 0);
        uint256 fee = (amountUsdcIn * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        uint256 netIn = amountUsdcIn - fee;
        (tokensOut, actualGrossPaid, refund) = _computeBuyView(s, netIn, fee);
    }

    function quoteSell(address tokenAddr, uint256 tokensIn) external view returns (uint256 usdcOut) {
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0) || s.migrated || tokensIn == 0) return 0;
        uint256 currentUsdc = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
        uint256 currentTokens = VIRTUAL_TOKEN_RESERVE - s.tokensSold;
        uint256 newTokenReserve = currentTokens + tokensIn;
        // MATH-002 mirror: ceiling division so quote == executed.
        uint256 newUsdcReserve = (K_CONSTANT + newTokenReserve - 1) / newTokenReserve;
        uint256 grossOut = currentUsdc - newUsdcReserve;
        if (grossOut > s.realUsdcReserve) grossOut = s.realUsdcReserve;
        uint256 fee = (grossOut * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        return grossOut - fee;
    }

    // Same as _computeBuy but `view` so external quote can reuse it.
    // Inner arithmetic wrapped in unchecked: VIRTUAL_USDC_RESERVE + realUsdcReserve
    // can't overflow (reserves cap at MIGRATION_THRESHOLD = 20k USDC); the curve
    // math invariants (tokensSold <= CURVE_SUPPLY < VIRTUAL_TOKEN_RESERVE) make
    // every subtraction safe; netIn is bounded by gross + USDC supply. Saves
    // ~300 bytes vs the checked version so ArcadeLaunchpad fits under EIP-170
    // after the audit-2 additions.
    function _computeBuyView(TokenState storage s, uint256 netIn, uint256 fee)
        internal
        view
        returns (uint256 tokensOut, uint256 actualGross, uint256 refund)
    {
        unchecked {
            uint256 currentUsdc = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
            uint256 currentTokens = VIRTUAL_TOKEN_RESERVE - s.tokensSold;
            uint256 newUsdcReserve = currentUsdc + netIn;
            // MATH-001 mirror so quote == executed.
            uint256 newTokenReserve = (K_CONSTANT + newUsdcReserve - 1) / newUsdcReserve;
            uint256 desiredOut = currentTokens - newTokenReserve;
            uint256 maxOut = CURVE_SUPPLY - s.tokensSold;
            if (desiredOut <= maxOut) {
                tokensOut = desiredOut;
                actualGross = netIn + fee;
                refund = 0;
            } else {
                tokensOut = maxOut;
                uint256 capTokenReserve = currentTokens - maxOut;
                uint256 capUsdcReserve = K_CONSTANT / capTokenReserve;
                if (K_CONSTANT % capTokenReserve != 0) capUsdcReserve += 1;
                uint256 actualNet = capUsdcReserve - currentUsdc;
                actualGross = (actualNet * FEE_DENOMINATOR + (FEE_DENOMINATOR - TRADE_FEE_BPS) - 1)
                    / (FEE_DENOMINATOR - TRADE_FEE_BPS);
                uint256 gross = netIn + fee;
                if (actualGross > gross) actualGross = gross;
                refund = gross - actualGross;
            }
        }
    }

    // ====================== Comments ======================

    function postComment(address tokenAddr, string calldata text) external {
        if (tokens[tokenAddr].token == address(0)) revert UnknownToken();
        uint256 len = bytes(text).length;
        if (len == 0) revert CommentEmpty();
        if (len > 280) revert CommentTooLong();
        Comment[] storage cs = tokenComments[tokenAddr];
        cs.push(Comment({author: msg.sender, timestamp: uint64(block.timestamp), text: text}));
        emit CommentPosted(tokenAddr, msg.sender, cs.length - 1, text);
    }

    function getCommentsCount(address tokenAddr) external view returns (uint256) {
        return tokenComments[tokenAddr].length;
    }

    function getComments(address tokenAddr, uint256 offset, uint256 limit)
        external
        view
        returns (Comment[] memory out)
    {
        Comment[] storage cs = tokenComments[tokenAddr];
        uint256 len = cs.length;
        if (offset >= len) return new Comment[](0);
        uint256 end = offset + limit;
        if (end > len) end = len;
        out = new Comment[](end - offset);
        for (uint256 i; i < out.length; ++i) {
            out[i] = cs[offset + i];
        }
    }
}
