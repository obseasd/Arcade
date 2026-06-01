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
    /// threshold, the V2 pair is seeded with 17,500 USDC + 200M tokens (the
    /// documented initial post-migration mcap), and 2,500 USDC goes to the
    /// treasury. If you change this, also update SECURITY.md and project memory.
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

    // --- Immutables ---

    IERC20 public immutable USDC;
    IArcadeV2Factory public immutable v2Factory;
    address public immutable v2Router;
    address public immutable treasury;
    /// @notice Uniswap V3 factory (for CLANKER_V3 vault migrations). May be the
    /// zero address on deployments that don't use V3 vaults.
    IArcadeV3Factory public immutable v3Factory;
    /// @notice WETH on Arc, used as the quote token for POOL_WETH launches.
    /// May be the zero address on deployments that don't offer WETH pools.
    address public immutable weth;
    /// @notice Deployer, allowed to wire the V3 locker exactly once.
    address public immutable deployer;
    /// @notice ArcadeV3Locker that permanently holds CLANKER_V3 LP positions.
    /// Set once post-deploy (the locker needs this contract's address at its
    /// own construction, so the wiring is circular and resolved via a setter).
    address public v3Locker;
    /// @notice ArcadeV3SwapRouter — used for the optional creator buy at launch.
    address public v3Router;
    /// @notice ArcadeTokenVault — holds the optional locked/vesting creator allocation.
    address public tokenVault;

    // --- State ---

    mapping(address => TokenState) public tokens;
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
        USDC.safeTransferFrom(msg.sender, treasury, CREATION_FEE);

        // Deploy new token (mints TOTAL_SUPPLY to this contract)
        ArcadeLaunchToken token = new ArcadeLaunchToken(name_, symbol_, TOTAL_SUPPLY, address(this));
        tokenAddr = address(token);

        TokenState storage s = tokens[tokenAddr];
        s.token = tokenAddr;
        s.creator = msg.sender;
        s.creator2 = creator2;
        s.creator2ShareBps = creator2 == address(0) ? 0 : creator2ShareBps;
        s.mode = mode;
        s.createdAt = uint64(block.timestamp);
        allTokens.push(tokenAddr);

        emit TokenCreated(tokenAddr, msg.sender, mode, creator2, s.creator2ShareBps, name_, symbol_, metadataURI);

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

        USDC.safeTransferFrom(msg.sender, treasury, CREATION_FEE);

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

        // The creator's launch buy executes inside `_launchClankerV3` before
        // this point. Arming the snipe config here means the creator pays no
        // tax on their own opening buy (it ran with `currentSnipeBps == 0`).
        // External buyers landing in the same block but AFTER this tx returns
        // are taxed normally because the config is now set; this is intended.
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
        uint256 creatorPortion = feeIn - platformFee;
        _payCreatorShare(s, creatorPortion);
        if (platformFee > 0) _safePayUsdc(treasury, platformFee);
    }

    /**
     * @dev Post-migration fee distribution: uniform 0.20% platform / 0.10%
     * creator regardless of mode. The creator portion can still be split
     * between two receivers (CLANKER feature).
     */
    function _distributeMigratedFee(TokenState storage s, uint256 totalRoyalty) internal {
        if (totalRoyalty == 0) return;
        // 2/3 of the 0.30% royalty goes to platform, 1/3 to creator (ceil to platform)
        uint256 platformFee = (totalRoyalty * MIGRATED_PLATFORM_BPS + MIGRATED_ROYALTY_BPS - 1)
            / MIGRATED_ROYALTY_BPS;
        if (platformFee > totalRoyalty) platformFee = totalRoyalty;
        uint256 creatorPortion = totalRoyalty - platformFee;
        _payCreatorShare(s, creatorPortion);
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
    function _safePayUsdc(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        try IERC20(address(USDC)).transfer(to, amount) returns (bool ok) {
            if (ok) return;
        } catch {
            // fall through to credit
        }
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

        uint256 fee = (amountUsdcIn * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        uint256 netIn = amountUsdcIn - fee;

        (tokensOut, usdcSpent, refund) = _computeBuy(s, netIn, fee);

        // tokensOut is the actual amount; usdcSpent is the actual gross paid.
        if (tokensOut < minTokensOut) revert Slippage();

        // Recompute fee on the actual gross spent (clamped to migration cap).
        uint256 actualFee = (usdcSpent * TRADE_FEE_BPS) / FEE_DENOMINATOR;

        // L-01: update curve state BEFORE _distributeFee. _distributeFee makes
        // external USDC transfers to creator + treasury; if any of those is a
        // contract that observes the launchpad's view state mid-call (eg a
        // future hook-enabled USDC), it would see a stale tokensSold /
        // realUsdcReserve. CEI-correct order.
        uint256 netUsdcAddedToReserve = usdcSpent - actualFee;
        s.realUsdcReserve += netUsdcAddedToReserve;
        s.tokensSold += tokensOut;

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

    /// @dev Returns (tokensOut, actualUsdcSpent_gross, refund). Caps the purchase
    /// so `tokensSold` never exceeds `CURVE_SUPPLY`. The ceiling-rounded
    /// `actualGross` is clamped to `netIn + fee` so the final buy in a curve fill
    /// never underflows `refund` on the last few microUSDC of slack.
    function _computeBuy(TokenState storage s, uint256 netIn, uint256 fee)
        internal
        view
        returns (uint256 tokensOut, uint256 actualGross, uint256 refund)
    {
        uint256 currentUsdc = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
        uint256 currentTokens = VIRTUAL_TOKEN_RESERVE - s.tokensSold;

        // Naive amount-out assuming we accept all of `netIn`:
        uint256 newUsdcReserve = currentUsdc + netIn;
        uint256 newTokenReserve = K_CONSTANT / newUsdcReserve;
        uint256 desiredOut = currentTokens - newTokenReserve;

        uint256 maxOut = CURVE_SUPPLY - s.tokensSold;
        if (desiredOut <= maxOut) {
            // Buy as much as the user asked for
            tokensOut = desiredOut;
            actualGross = netIn + fee;
            refund = 0;
        } else {
            // Cap at maxOut, refund the rest
            tokensOut = maxOut;
            uint256 capTokenReserve = currentTokens - maxOut;
            uint256 capUsdcReserve = K_CONSTANT / capTokenReserve;
            // Round up to ensure the cap is actually reachable
            if (K_CONSTANT % capTokenReserve != 0) {
                capUsdcReserve += 1;
            }
            uint256 actualNet = capUsdcReserve - currentUsdc;
            // gross such that gross * (1 - feeBps/10000) >= actualNet, i.e. gross = actualNet * 10000 / (10000 - feeBps)
            actualGross = (actualNet * FEE_DENOMINATOR + (FEE_DENOMINATOR - TRADE_FEE_BPS) - 1)
                / (FEE_DENOMINATOR - TRADE_FEE_BPS);
            // Clamp: with tiny `netIn` where the fee floors to 0, the ceiling
            // above can yield `actualGross > netIn + fee`. The 1-2 microUSDC
            // accounting drift goes to the curve and refund stays at 0.
            uint256 gross = netIn + fee;
            if (actualGross > gross) actualGross = gross;
            refund = gross - actualGross;
        }
    }

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

        // Compute gross USDC out on the curve
        uint256 currentUsdc = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
        uint256 currentTokens = VIRTUAL_TOKEN_RESERVE - s.tokensSold;
        uint256 newTokenReserve = currentTokens + tokensIn;
        uint256 newUsdcReserve = K_CONSTANT / newTokenReserve;
        uint256 grossOut = currentUsdc - newUsdcReserve;

        if (grossOut > s.realUsdcReserve) {
            // Should not happen if math is correct, but guard the dust case
            grossOut = s.realUsdcReserve;
        }

        uint256 fee = (grossOut * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        usdcOut = grossOut - fee;
        if (usdcOut < minUsdcOut) revert Slippage();

        // Update state
        s.realUsdcReserve -= grossOut;
        s.tokensSold -= tokensIn;

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
        if (usdcIn == 0) revert ZeroAmount();
        if (v2Router == address(0)) revert NoRouter();

        USDC.safeTransferFrom(msg.sender, address(this), usdcIn);

        uint256 royalty = (usdcIn * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR;
        if (royalty > 0) _distributeMigratedFee(s, royalty);

        uint256 netIn = usdcIn - royalty;
        USDC.forceApprove(v2Router, netIn);

        address[] memory path = new address[](2);
        path[0] = address(USDC);
        path[1] = tokenAddr;
        uint256[] memory amounts = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            netIn, minTokensOut, path, msg.sender, deadline
        );
        tokensOut = amounts[1];
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
        if (tokensIn == 0) revert ZeroAmount();
        if (v2Router == address(0)) revert NoRouter();

        IERC20(tokenAddr).safeTransferFrom(msg.sender, address(this), tokensIn);
        IERC20(tokenAddr).forceApprove(v2Router, tokensIn);

        address[] memory path = new address[](2);
        path[0] = tokenAddr;
        path[1] = address(USDC);
        uint256[] memory amounts = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            tokensIn, 0, path, address(this), deadline
        );
        uint256 grossUsdc = amounts[1];

        uint256 royalty = (grossUsdc * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR;
        usdcOut = grossUsdc - royalty;
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
    function swapMigratedRoute(
        address tokenIn,
        address tokenOut,
        uint256 tokensIn,
        uint256 minTokensOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (v2Router == address(0)) revert NoRouter();
        if (tokensIn == 0) revert ZeroAmount();
        // Same token / USDC short-circuits aren't unknown tokens, they're just
        // unsupported routes here. Use `InvalidRoute()` so the caller can
        // disambiguate from a never-launched token.
        if (
            tokenIn == tokenOut
                || tokenIn == address(USDC)
                || tokenOut == address(USDC)
        ) revert InvalidRoute();

        TokenState storage sIn = tokens[tokenIn];
        TokenState storage sOut = tokens[tokenOut];
        bool inMigrated = sIn.token != address(0) && sIn.migrated;
        bool outMigrated = sOut.token != address(0) && sOut.migrated;

        // --- Leg 1: tokenIn -> USDC ---
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), tokensIn);
        IERC20(tokenIn).forceApprove(v2Router, tokensIn);

        address[] memory path1 = new address[](2);
        path1[0] = tokenIn;
        path1[1] = address(USDC);
        uint256[] memory leg1 = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            tokensIn, 0, path1, address(this), deadline
        );
        uint256 usdcMid = leg1[1];

        // Royalty on the USDC produced by selling tokenIn
        if (inMigrated) {
            uint256 royaltyA = (usdcMid * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR;
            if (royaltyA > 0) {
                _distributeMigratedFee(sIn, royaltyA);
                usdcMid -= royaltyA;
            }
        }

        // Royalty on the USDC about to be spent buying tokenOut
        if (outMigrated) {
            uint256 royaltyB = (usdcMid * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR;
            if (royaltyB > 0) {
                _distributeMigratedFee(sOut, royaltyB);
                usdcMid -= royaltyB;
            }
        }

        // --- Leg 2: USDC -> tokenOut, delivered to the user ---
        USDC.forceApprove(v2Router, usdcMid);
        address[] memory path2 = new address[](2);
        path2[0] = address(USDC);
        path2[1] = tokenOut;
        uint256[] memory leg2 = IArcadeV2Router(v2Router).swapExactTokensForTokens(
            usdcMid, minTokensOut, path2, msg.sender, deadline
        );
        tokensOut = leg2[1];
        if (tokensOut < minTokensOut) revert Slippage();
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
        if (
            tokenIn == tokenOut
                || tokenIn == address(USDC)
                || tokenOut == address(USDC)
        ) return (0, 0);

        bool inMigrated = tokens[tokenIn].token != address(0) && tokens[tokenIn].migrated;
        bool outMigrated = tokens[tokenOut].token != address(0) && tokens[tokenOut].migrated;

        address[] memory path1 = new address[](2);
        path1[0] = tokenIn;
        path1[1] = address(USDC);
        uint256[] memory leg1 = IArcadeV2Router(v2Router).getAmountsOut(tokensIn, path1);
        uint256 usdcMid = leg1[1];

        uint256 royaltyA = inMigrated ? (usdcMid * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR : 0;
        usdcMid -= royaltyA;
        uint256 royaltyB = outMigrated ? (usdcMid * MIGRATED_ROYALTY_BPS) / FEE_DENOMINATOR : 0;
        usdcMid -= royaltyB;
        totalRoyaltyUsdc = royaltyA + royaltyB;

        address[] memory path2 = new address[](2);
        path2[0] = address(USDC);
        path2[1] = tokenOut;
        uint256[] memory leg2 = IArcadeV2Router(v2Router).getAmountsOut(usdcMid, path2);
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

        // H-05: take MIGRATION_FEE off the top to the treasury. With the
        // standard 20k raised, the pair gets 17.5k seed + 2.5k goes to
        // platform. Guard against an under-funded reserve (shouldn't happen
        // since migration triggers at realUsdcReserve == 20k exactly, but
        // belt-and-suspenders if curve params ever change).
        uint256 raised = s.realUsdcReserve;
        s.realUsdcReserve = 0;
        uint256 platformCut = raised >= MIGRATION_FEE ? MIGRATION_FEE : raised;
        uint256 usdcForLP = raised - platformCut;
        uint256 tokensForLP = MIGRATION_LP_TOKENS;

        if (platformCut > 0) {
            _safePayUsdc(treasury, platformCut);
        }

        address pair = v2Factory.getPair(address(USDC), tokenAddr);
        if (pair == address(0)) {
            pair = v2Factory.createPair(address(USDC), tokenAddr);
        }
        // M-09: neutralise any pre-donation an attacker may have made to the
        // pair's deterministic address before migration. We pay only the
        // difference between intended LP seed and the existing balance, so
        // the pair always ends up with exactly `usdcForLP` (or `preBalance`,
        // whichever is larger) post-mint. Any saved USDC goes to the
        // treasury, neutralising the price-shift grief vector. Skim AFTER
        // mint cleans up any donation that arrives between getPair and mint.
        uint256 preBalance = USDC.balanceOf(pair);
        uint256 toTransfer = usdcForLP > preBalance ? usdcForLP - preBalance : 0;
        if (toTransfer > 0) {
            USDC.safeTransfer(pair, toTransfer);
        }
        IERC20(tokenAddr).safeTransfer(pair, tokensForLP);
        IArcadeV2Pair(pair).mint(DEAD);
        IArcadeV2Pair(pair).skim(treasury);
        // The portion of our intended seed that the attacker's donation
        // already covered is now ours to redirect. Pay it to the treasury
        // alongside the migration fee.
        uint256 saved = usdcForLP - toTransfer;
        if (saved > 0) {
            _safePayUsdc(treasury, saved);
        }
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
        IArcadeV3Pool(pool).initialize(sqrtPriceX96);

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
                recipients: recipients
            })
        );

        emit Migrated(tokenAddr, pool, 0, lpSupply);

        // Optional creator buy (USDC pools only; the router pivots through USDC).
        if (creatorBuyUsdc > 0) {
            USDC.safeTransferFrom(s.creator, address(this), creatorBuyUsdc);
            USDC.forceApprove(v3Router, creatorBuyUsdc);
            IArcadeV3Router(v3Router).exactInputSingle(
                address(USDC), tokenAddr, fee, s.creator, creatorBuyUsdc, 0, block.timestamp + 600
            );
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
        if (s.migrated) {
            if (s.mode == LaunchMode.CLANKER_V3) {
                return _v3MarketCap(s);
            }
            // PUMP / Arcade post-migration: V2 pair reserves.
            (uint112 r0, uint112 r1,) = IArcadeV2Pair(s.v2Pair).getReserves();
            address t0 = IArcadeV2Pair(s.v2Pair).token0();
            (uint256 usdcReserve, uint256 tokenReserve) =
                t0 == address(USDC) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            if (tokenReserve == 0) return 0;
            // price = usdcReserve / tokenReserve (USDC per token-raw)
            // mcap = price * TOTAL_SUPPLY = usdcReserve * TOTAL_SUPPLY / tokenReserve
            return (usdcReserve * TOTAL_SUPPLY) / tokenReserve;
        }
        uint256 currentUsdc = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
        uint256 currentTokens = VIRTUAL_TOKEN_RESERVE - s.tokensSold;
        if (currentTokens == 0) return 0;
        return (currentUsdc * TOTAL_SUPPLY) / currentTokens;
    }

    /// @dev mcap for a CLANKER_V3 token, derived from the V3 pool price.
    /// Only meaningful for USDC-paired pools (POOL_WETH returns 0 here since we
    /// don't price WETH internally — the frontend handles the WETH conversion).
    function _v3MarketCap(TokenState storage s) internal view returns (uint256) {
        address pool = s.v2Pair;
        if (pool == address(0)) return 0;
        (uint160 sqrtPriceX96,,,,,,) = IArcadeV3Pool(pool).slot0();
        if (sqrtPriceX96 == 0) return 0;
        address token0 = IArcadeV3Pool(pool).token0();
        // Only handle USDC-paired pools here.
        if (token0 != address(USDC) && IArcadeV3Pool(pool).token1() != address(USDC)) return 0;
        bool usdcIsToken0 = token0 == address(USDC);
        // price1per0 = (sqrtPriceX96 / 2**96)^2 = token1_amount per token0_amount
        // To avoid overflow on sqrt^2 we compute mcap directly:
        //   if usdcIsToken0 (token = token1):
        //     usdc_per_token = 1 / price1per0 = (2**192) / sqrtPriceX96^2
        //     mcap = usdc_per_token * TOTAL_SUPPLY
        //   else (token = token0):
        //     usdc_per_token = price1per0 = sqrtPriceX96^2 / 2**192
        //     mcap = usdc_per_token * TOTAL_SUPPLY
        uint256 numerator;
        uint256 denominator;
        if (usdcIsToken0) {
            // mcap = TOTAL_SUPPLY * 2**192 / sqrtPriceX96^2
            numerator = TOTAL_SUPPLY * (1 << 96);
            denominator = uint256(sqrtPriceX96);
            uint256 part = numerator / denominator;
            // part = TOTAL_SUPPLY * 2**96 / sqrtPriceX96; finish with another /sqrt
            return (part * (1 << 96)) / uint256(sqrtPriceX96);
        } else {
            // mcap = TOTAL_SUPPLY * sqrtPriceX96^2 / 2**192
            uint256 p = uint256(sqrtPriceX96);
            // Done in two steps to keep intermediate within 256-bit:
            // first compute (p * TOTAL_SUPPLY) / 2**96, then * p / 2**96
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
        uint256 newUsdcReserve = K_CONSTANT / newTokenReserve;
        uint256 grossOut = currentUsdc - newUsdcReserve;
        if (grossOut > s.realUsdcReserve) grossOut = s.realUsdcReserve;
        uint256 fee = (grossOut * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        return grossOut - fee;
    }

    // Same as _computeBuy but `view` so external quote can reuse it.
    function _computeBuyView(TokenState storage s, uint256 netIn, uint256 fee)
        internal
        view
        returns (uint256 tokensOut, uint256 actualGross, uint256 refund)
    {
        uint256 currentUsdc = VIRTUAL_USDC_RESERVE + s.realUsdcReserve;
        uint256 currentTokens = VIRTUAL_TOKEN_RESERVE - s.tokensSold;
        uint256 newUsdcReserve = currentUsdc + netIn;
        uint256 newTokenReserve = K_CONSTANT / newUsdcReserve;
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
