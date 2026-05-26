// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ArcadeLaunchToken} from "./ArcadeLaunchToken.sol";
import {IArcadeLaunchpad} from "./interfaces/IArcadeLaunchpad.sol";
import {IArcadeV2Factory} from "../dex/interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Pair} from "../dex/interfaces/IArcadeV2Pair.sol";

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

    uint256 public constant CREATION_FEE = 2e6; // 2 USDC
    uint256 public constant TRADE_FEE_BPS = 100; // 1% total
    uint256 public constant FEE_DENOMINATOR = 10_000;

    // PUMP mode: 50% platform / 50% creator(s)
    uint256 public constant PUMP_PLATFORM_BPS = 5_000; // 50% of the trade fee
    // CLANKER mode: 70% platform / 30% creator(s)
    uint256 public constant CLANKER_PLATFORM_BPS = 7_000; // 70% of the trade fee

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // --- Immutables ---

    IERC20 public immutable USDC;
    IArcadeV2Factory public immutable v2Factory;
    address public immutable treasury;

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

    constructor(IERC20 usdc_, IArcadeV2Factory v2Factory_, address treasury_) {
        USDC = usdc_;
        v2Factory = v2Factory_;
        treasury = treasury_;
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
        if (uint8(mode) > 1) revert InvalidMode();
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
    }

    /**
     * @dev Internal helper that splits a trade fee between platform, creator
     * and (optionally) a secondary creator receiver, then settles the USDC
     * transfers. Returns the *total* fee dispatched (always equal to `feeIn`,
     * minus any zero-amount transfers skipped for gas).
     */
    function _distributeFee(TokenState storage s, uint256 feeIn) internal {
        if (feeIn == 0) return;
        uint256 platformBps = s.mode == LaunchMode.PUMP ? PUMP_PLATFORM_BPS : CLANKER_PLATFORM_BPS;
        uint256 platformFee = (feeIn * platformBps) / 10_000;
        uint256 creatorPortion = feeIn - platformFee;

        uint256 creator2Cut = 0;
        if (s.creator2 != address(0) && s.creator2ShareBps > 0) {
            creator2Cut = (creatorPortion * s.creator2ShareBps) / 10_000;
        }
        uint256 creator1Cut = creatorPortion - creator2Cut;

        if (platformFee > 0) USDC.safeTransfer(treasury, platformFee);
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

    // ====================== Migration ======================

    function _migrate(address tokenAddr) internal {
        TokenState storage s = tokens[tokenAddr];
        s.migrated = true;
        s.migratedAt = uint64(block.timestamp);

        uint256 usdcForLP = s.realUsdcReserve;
        // The launchpad currently holds (TOTAL_SUPPLY - tokensSold) = MIGRATION_LP_TOKENS tokens
        uint256 tokensForLP = MIGRATION_LP_TOKENS;

        // Find or create the V2 pair
        address pair = v2Factory.getPair(address(USDC), tokenAddr);
        if (pair == address(0)) {
            pair = v2Factory.createPair(address(USDC), tokenAddr);
        }

        // Push the liquidity directly to the pair
        USDC.safeTransfer(pair, usdcForLP);
        IERC20(tokenAddr).safeTransfer(pair, tokensForLP);

        // Mint LP tokens to the dead address (permanent lock)
        IArcadeV2Pair(pair).mint(DEAD);

        // Zero out the curve reserves (now in the pool)
        s.realUsdcReserve = 0;
        s.v2Pair = pair;

        emit Migrated(tokenAddr, pair, usdcForLP, tokensForLP);
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
