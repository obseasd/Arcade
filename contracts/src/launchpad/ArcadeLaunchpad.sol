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
 * @notice Bonding-curve launchpad with two launch modes:
 *         - PUMP   : pump.fun-style — 50% platform / 50% creator(s)
 *         - CLANKER: Clanker-style  — 70% platform / 30% creator(s), with the
 *                    option to split the creator share between two addresses
 *
 *         Each new token is a fixed-supply ERC20 (1B, 18 decimals) minted
 *         entirely into this contract. Trading happens against virtual USDC
 *         reserves on a constant-product curve. When the curve sells out
 *         (800M tokens), the contract seeds a Uniswap V2 pool with the
 *         collected USDC + the 200M unsold tokens, then burns the LP tokens
 *         to a dead address.
 *
 * Trade fee: 1% of every swap, taken in USDC; split per mode as above.
 * Creation fee: 2 USDC, paid to treasury at launch.
 *
 * USDC has 6 decimals on Arc. Token has 18 decimals.
 */
contract ArcadeLaunchpad is IArcadeLaunchpad, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant MIGRATION_LP_TOKENS = TOTAL_SUPPLY - CURVE_SUPPLY; // 200M
    uint256 public constant VIRTUAL_USDC_RESERVE = 5_000e6;
    uint256 public constant VIRTUAL_TOKEN_RESERVE = 1_000_000_000e18;
    uint256 public constant K_CONSTANT = VIRTUAL_USDC_RESERVE * VIRTUAL_TOKEN_RESERVE;
    uint256 public constant MIGRATION_USDC_TARGET = 20_000e6; // 20,000 USDC raised

    uint256 public constant CREATION_FEE = 3e6; // 3 USDC
    uint256 public constant TRADE_FEE_BPS = 100; // 1% total
    uint256 public constant FEE_DENOMINATOR = 10_000;

    // PUMP mode: 50% platform / 50% creator(s)
    uint256 public constant PUMP_PLATFORM_BPS = 5_000; // 50% of the trade fee
    // CLANKER mode: 70% platform / 30% creator(s)
    uint256 public constant CLANKER_PLATFORM_BPS = 7_000; // 70% of the trade fee

    /// @notice Post-migration royalty taken on top of V2 LP fees when the
    /// swap is routed through `buyMigrated` / `sellMigrated`. Uniform split
    /// across both launch modes (the bonding-curve split logic only applies
    /// while the curve is active).
    uint256 public constant MIGRATED_PLATFORM_BPS = 20; // 0.20% to platform
    uint256 public constant MIGRATED_CREATOR_BPS = 10; // 0.10% to creator(s)
    uint256 public constant MIGRATED_ROYALTY_BPS = MIGRATED_PLATFORM_BPS + MIGRATED_CREATOR_BPS; // 0.30% total

    // --- V3 vault (CLANKER_V3) migration params ---
    /// @notice V3 pool fee tier used for vault migrations: 1% (matches the
    /// high-fee, creator-friendly Clanker model).
    uint24 public constant V3_FEE = 10_000;
    /// @notice Tick spacing for the 1% fee tier.
    int24 public constant V3_TICK_SPACING = 200;
    /// @notice Creator's share of V3 LP fees in the locker (80%); platform gets 20%.
    uint16 public constant V3_CREATOR_BPS = 8_000;
    /// @notice Starting fully-diluted valuation for a CLANKER_V3 single-sided
    /// launch, in USDC (6dp). The whole supply is placed single-sided at this
    /// FDV; price rises as the token is bought. Tunable.
    uint256 public constant CLANKER_V3_START_FDV = 5_000e6; // 5,000 USDC
    /// @notice Max share of supply that can be vaulted (locked/vesting) for the
    /// creator; the rest must go to the LP. 90%.
    uint16 public constant MAX_VAULT_BPS = 9_000;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // --- Immutables ---

    IERC20 public immutable USDC;
    IArcadeV2Factory public immutable v2Factory;
    address public immutable v2Router;
    address public immutable treasury;
    /// @notice Uniswap V3 factory (for CLANKER_V3 vault migrations). May be the
    /// zero address on deployments that don't use V3 vaults.
    IArcadeV3Factory public immutable v3Factory;
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

    /// @notice Optional locked/vesting creator allocation for a CLANKER_V3 launch.
    struct VaultConfig {
        uint16 pct; // bps of supply to vault (0 = none, max MAX_VAULT_BPS)
        uint64 lockupDuration; // ≥ vault MIN_LOCKUP when pct > 0
        uint64 vestingDuration; // linear vesting after lockup (0 = clean cliff)
        address recipient;
    }

    constructor(
        IERC20 usdc_,
        IArcadeV2Factory v2Factory_,
        address v2Router_,
        address treasury_,
        IArcadeV3Factory v3Factory_
    ) {
        USDC = usdc_;
        v2Factory = v2Factory_;
        v2Router = v2Router_;
        treasury = treasury_;
        v3Factory = v3Factory_;
        deployer = msg.sender;
    }

    /// @notice One-time wiring of the V3 locker + router (resolves the
    /// launchpad<->locker circular constructor dependency, and gives the
    /// launchpad the router it uses for the optional creator buy). Deployer-only.
    function setV3Infra(address locker, address router, address vault) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (v3Locker != address(0)) revert LockerAlreadySet();
        v3Locker = locker;
        v3Router = router;
        tokenVault = vault;
    }

    /// @dev Back-compat shim — wires the locker only. Prefer setV3Infra.
    function setV3Locker(address locker) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (v3Locker != address(0)) revert LockerAlreadySet();
        v3Locker = locker;
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
        s.metadataURI = metadataURI;
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
            _launchClankerV3(s, tokenAddr, rs, V3_FEE, 0, TOTAL_SUPPLY);
        }
    }

    /**
     * @notice Clanker-style launch with up to 3 custom fee recipients. No
     * bonding curve — the full supply is locked single-sided in a V3 pool at
     * creation. `recipients` bps must sum to 10000 and cover both fee sides
     * (validated by the locker). Each recipient carries an admin that can later
     * rotate its payout address / admin.
     */
    function createClankerV3(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI,
        IArcadeV3Locker.Recipient[] calldata recipients,
        uint24 fee,
        uint256 creatorBuyUsdc,
        VaultConfig calldata vault
    ) external nonReentrant returns (address tokenAddr) {
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert EmptyName();
        if (address(v3Factory) == address(0) || v3Locker == address(0)) revert V3NotConfigured();
        // Static fee tier: 1% / 2% / 3%.
        if (fee != 10_000 && fee != 20_000 && fee != 30_000) revert BadFeeTier();
        if (creatorBuyUsdc > 0 && v3Router == address(0)) revert NoRouter();
        if (vault.pct > 0 && (vault.pct > MAX_VAULT_BPS || tokenVault == address(0))) revert BadVault();

        USDC.safeTransferFrom(msg.sender, treasury, CREATION_FEE);

        ArcadeLaunchToken token = new ArcadeLaunchToken(name_, symbol_, TOTAL_SUPPLY, address(this));
        tokenAddr = address(token);

        TokenState storage s = tokens[tokenAddr];
        s.token = tokenAddr;
        s.creator = msg.sender;
        s.mode = LaunchMode.CLANKER_V3;
        s.createdAt = uint64(block.timestamp);
        s.metadataURI = metadataURI;
        allTokens.push(tokenAddr);

        emit TokenCreated(tokenAddr, msg.sender, LaunchMode.CLANKER_V3, address(0), 0, name_, symbol_, metadataURI);

        // Carve out the optional vaulted (locked/vesting) allocation; the rest
        // is the single-sided LP supply.
        uint256 lpSupply = TOTAL_SUPPLY;
        if (vault.pct > 0) {
            uint256 vaultAmount = (TOTAL_SUPPLY * vault.pct) / FEE_DENOMINATOR;
            lpSupply = TOTAL_SUPPLY - vaultAmount;
            IERC20(tokenAddr).safeTransfer(tokenVault, vaultAmount);
            IArcadeTokenVault(tokenVault).createVest(
                tokenAddr, vault.recipient, vaultAmount, vault.lockupDuration, vault.vestingDuration
            );
        }

        IArcadeV3Locker.Recipient[] memory rs = recipients; // calldata -> memory
        _launchClankerV3(s, tokenAddr, rs, fee, creatorBuyUsdc, lpSupply);
    }

    /**
     * @dev Bonding-curve fee distribution: split depends on the token's
     * launch mode (PUMP 50/50 vs CLANKER 70/30) and optionally splits the
     * creator portion between two receivers (CLANKER).
     */
    function _distributeFee(TokenState storage s, uint256 feeIn) internal {
        if (feeIn == 0) return;
        uint256 platformBps = s.mode == LaunchMode.PUMP ? PUMP_PLATFORM_BPS : CLANKER_PLATFORM_BPS;
        uint256 platformFee = (feeIn * platformBps) / 10_000;
        uint256 creatorPortion = feeIn - platformFee;
        _payCreatorShare(s, creatorPortion);
        if (platformFee > 0) USDC.safeTransfer(treasury, platformFee);
    }

    /**
     * @dev Post-migration fee distribution: uniform 0.20% platform / 0.10%
     * creator regardless of mode. The creator portion can still be split
     * between two receivers (CLANKER feature).
     */
    function _distributeMigratedFee(TokenState storage s, uint256 totalRoyalty) internal {
        if (totalRoyalty == 0) return;
        // 2/3 of the 0.30% royalty goes to platform, 1/3 to creator
        uint256 platformFee = (totalRoyalty * MIGRATED_PLATFORM_BPS) / MIGRATED_ROYALTY_BPS;
        uint256 creatorPortion = totalRoyalty - platformFee;
        _payCreatorShare(s, creatorPortion);
        if (platformFee > 0) USDC.safeTransfer(treasury, platformFee);
    }

    /// @dev Splits the creator portion between creator and (optional) creator2.
    function _payCreatorShare(TokenState storage s, uint256 creatorPortion) internal {
        if (creatorPortion == 0) return;
        uint256 creator2Cut = 0;
        if (s.creator2 != address(0) && s.creator2ShareBps > 0) {
            creator2Cut = (creatorPortion * s.creator2ShareBps) / 10_000;
        }
        uint256 creator1Cut = creatorPortion - creator2Cut;
        if (creator1Cut > 0) USDC.safeTransfer(s.creator, creator1Cut);
        if (creator2Cut > 0) USDC.safeTransfer(s.creator2, creator2Cut);
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

        // Recompute fee on the actual gross spent (clamped to migration cap),
        // then distribute per the token's launch mode.
        uint256 actualFee = (usdcSpent * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        _distributeFee(s, actualFee);

        // Update curve state (real USDC excludes fees — fees never enter the reserve)
        uint256 netUsdcAddedToReserve = usdcSpent - actualFee;
        s.realUsdcReserve += netUsdcAddedToReserve;
        s.tokensSold += tokensOut;

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
    /// so `tokensSold` never exceeds `CURVE_SUPPLY`.
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
            refund = (netIn + fee) - actualGross;
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
    function buyMigrated(address tokenAddr, uint256 usdcIn, uint256 minTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
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
            netIn, minTokensOut, path, msg.sender, block.timestamp + 600
        );
        tokensOut = amounts[1];
    }

    /// @notice Sell a migrated token via V2, then skim the royalty from the USDC output.
    function sellMigrated(address tokenAddr, uint256 tokensIn, uint256 minUsdcOut)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
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
            tokensIn, 0, path, address(this), block.timestamp + 600
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
        uint256 minTokensOut
    ) external nonReentrant returns (uint256 tokensOut) {
        if (v2Router == address(0)) revert NoRouter();
        if (tokensIn == 0) revert ZeroAmount();
        if (
            tokenIn == tokenOut
                || tokenIn == address(USDC)
                || tokenOut == address(USDC)
        ) revert UnknownToken();

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
            tokensIn, 0, path1, address(this), block.timestamp + 600
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
            usdcMid, minTokensOut, path2, msg.sender, block.timestamp + 600
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

        uint256 usdcForLP = s.realUsdcReserve;
        uint256 tokensForLP = MIGRATION_LP_TOKENS;
        s.realUsdcReserve = 0;

        address pair = v2Factory.getPair(address(USDC), tokenAddr);
        if (pair == address(0)) {
            pair = v2Factory.createPair(address(USDC), tokenAddr);
        }
        USDC.safeTransfer(pair, usdcForLP);
        IERC20(tokenAddr).safeTransfer(pair, tokensForLP);
        IArcadeV2Pair(pair).mint(DEAD);
        s.v2Pair = pair;
        emit Migrated(tokenAddr, pair, usdcForLP, tokensForLP);
    }

    /// @dev Clanker-style immediate launch (no bonding curve): deploy a Uniswap
    /// V3 pool initialized at CLANKER_V3_START_FDV, then lock the ENTIRE supply
    /// single-sided in ArcadeV3Locker. The token is tradeable immediately; price
    /// rises as it's bought and USDC accumulates in the locked position. The
    /// creator earns 80% of perpetual LP fees (platform 20%); principal is
    /// locked forever. Called from `createToken` for CLANKER_V3.
    function _launchClankerV3(
        TokenState storage s,
        address tokenAddr,
        IArcadeV3Locker.Recipient[] memory recipients,
        uint24 fee,
        uint256 creatorBuyUsdc,
        uint256 lpSupply
    ) internal {
        // Start price is FDV-based on the FULL supply, regardless of how much
        // is actually placed in the LP (the rest may be vaulted).
        (address token0, address token1, uint256 amount0, uint256 amount1) = address(USDC) < tokenAddr
            ? (address(USDC), tokenAddr, CLANKER_V3_START_FDV, TOTAL_SUPPLY)
            : (tokenAddr, address(USDC), TOTAL_SUPPLY, CLANKER_V3_START_FDV);

        address pool = v3Factory.getPool(token0, token1, fee);
        if (pool == address(0)) {
            pool = v3Factory.createPool(token0, token1, fee);
        }
        uint160 sqrtPriceX96 = ArcadeV3PriceMath.encodeSqrtPriceX96(amount1, amount0);
        IArcadeV3Pool(pool).initialize(sqrtPriceX96);

        // Hand the LP supply (total minus any vaulted amount) to the locker.
        IERC20(tokenAddr).safeTransfer(v3Locker, lpSupply);
        IArcadeV3Locker(v3Locker).lockSingleSided(
            IArcadeV3Locker.SingleSidedParams({
                pool: pool,
                paired: address(USDC),
                token: tokenAddr,
                sqrtPriceX96: sqrtPriceX96,
                tokenAmount: lpSupply,
                recipients: recipients
            })
        );

        s.migrated = true;
        s.migratedAt = uint64(block.timestamp);
        s.v2Pair = pool; // reuse the field to store the (V3) pool address
        emit Migrated(tokenAddr, pool, 0, lpSupply);

        // Optional creator buy: the creator spends USDC to buy their token at
        // launch (they're the first buyer; price starts at the range bottom).
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

    /// @notice Returns the implied market cap of `tokenAddr` in USDC raw units (6 dp).
    function marketCap(address tokenAddr) external view returns (uint256) {
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0)) return 0;
        if (s.migrated) {
            // Post-migration: use V2 pair reserves to derive price
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

    /// @notice Quote tokens out for a hypothetical buy of `amountUsdcIn` (gross).
    function quoteBuy(address tokenAddr, uint256 amountUsdcIn)
        external
        view
        returns (uint256 tokensOut, uint256 refund)
    {
        TokenState storage s = tokens[tokenAddr];
        if (s.token == address(0) || s.migrated || amountUsdcIn == 0) return (0, 0);
        uint256 fee = (amountUsdcIn * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        uint256 netIn = amountUsdcIn - fee;
        (uint256 out, uint256 actualGross, uint256 _refund) = _computeBuyView(s, netIn, fee);
        actualGross; // silence
        return (out, _refund);
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
            refund = (netIn + fee) - actualGross;
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
