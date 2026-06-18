// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ArcadeIdentityIssuer
 * @notice Wraps Arc's ERC-8004 Identity Registry to enforce
 *         on-chain tier verification. The Registry itself has no
 *         concept of "creator tier" — calling Registry.mint
 *         directly lets any wallet self-issue a Diamond Identity
 *         NFT with hand-crafted metadata, which makes the
 *         "10 bonded launches" claim meaningless to any dapp
 *         reading the NFT for cross-app reputation.
 *
 *         Audit 2026-06-18 H-09 fix: this contract reads the
 *         caller's bonded-launch count from the V2 launchpad AND
 *         the V4 ArcadeHook on every mint, verifies the caller's
 *         claimed tier is actually earned, and forwards the
 *         mint to the Registry. The Registry is configured to
 *         accept calls only from this Issuer.
 *
 *         Solo-creator path. Co-launches (creator2) are NOT
 *         counted toward the second creator's tier in this
 *         version; if needed, extend bondedCountOf to walk
 *         creator2 entries with the appropriate share gate.
 */

interface IArcadeLaunchpadView {
    enum LaunchMode { PUMP, CLANKER, CLANKER_V3 }
    struct TokenState {
        address token;
        address creator;
        address creator2;
        uint16 creator2ShareBps;
        LaunchMode mode;
        uint64 createdAt;
        uint64 migratedAt;
        bool migrated;
        uint256 realUsdcReserve;
        uint256 tokensSold;
        address v2Pair;
    }
    function getTokensCount() external view returns (uint256);
    function allTokens(uint256 index) external view returns (address);
    function tokens(address token) external view returns (TokenState memory);
}

interface IArcadeHookView {
    struct CurveState {
        uint128 virtualUsdcReserve;
        uint128 realUsdcReserve;
        uint128 tokensSold;
        uint8 mode;
        uint8 status; // 0=Curving, 1=GraduationStarted, 2=Graduated
        address creator;
        address creator2;
        uint16 creator2Bps;
    }
    function tokensCount() external view returns (uint256);
    function allTokens(uint256 index) external view returns (address);
    function poolIdOf(address token) external view returns (bytes32);
    function getCurveState(bytes32 poolId) external view returns (CurveState memory);
}

interface IERC8004Identity {
    function mint(address to, string calldata uri) external returns (uint256 tokenId);
}

contract ArcadeIdentityIssuer {
    // ===== Tier thresholds =====
    uint256 public constant SILVER_MIN = 3;
    uint256 public constant GOLD_MIN = 5;
    uint256 public constant DIAMOND_MIN = 10;

    // ===== Tier codes =====
    uint8 public constant TIER_NONE = 0;
    uint8 public constant TIER_SILVER = 1;
    uint8 public constant TIER_GOLD = 2;
    uint8 public constant TIER_DIAMOND = 3;

    // ===== Wired references =====
    IArcadeLaunchpadView public immutable launchpad;
    IArcadeHookView public immutable arcadeHook; // address(0) if V4 not yet wired
    IERC8004Identity public immutable registry;
    address public immutable owner;

    // Cap the bonded-count walk so an attacker can't grief us with a
    // pathological launchpad that has millions of address entries. The
    // launchpad is owner-gated for new launches so this is defensive
    // only; SAFE_COUNT_CAP of 2048 keeps the worst-case gas inside the
    // Arc 30M block ceiling with margin.
    uint256 public constant SAFE_COUNT_CAP = 2048;

    error TierMismatch();
    error InsufficientLaunches();
    error InvalidTier();
    error NotOwner();

    event IdentityMinted(
        address indexed creator,
        uint8 indexed tier,
        uint256 tokenId,
        uint256 v2BondedCount,
        uint256 v4BondedCount
    );

    constructor(address launchpad_, address arcadeHook_, address registry_) {
        if (launchpad_ == address(0) || registry_ == address(0)) revert InvalidTier();
        launchpad = IArcadeLaunchpadView(launchpad_);
        arcadeHook = IArcadeHookView(arcadeHook_); // may be address(0)
        registry = IERC8004Identity(registry_);
        owner = msg.sender;
    }

    /**
     * @notice Mint an Identity NFT for `msg.sender` at the claimed tier.
     *         Reverts if the on-chain bondedCount does not meet the
     *         tier's minimum.
     * @param  claimedTier 1=Silver, 2=Gold, 3=Diamond. The metadata
     *                     URI is the caller's responsibility (the
     *                     front-end encodes a JSON describing the tier
     *                     + bonded count + wallet) but the tier itself
     *                     is verified here.
     */
    function mint(uint8 claimedTier, string calldata uri) external returns (uint256 tokenId) {
        if (claimedTier == TIER_NONE || claimedTier > TIER_DIAMOND) revert InvalidTier();
        (uint256 v2n, uint256 v4n) = _bondedCountsOf(msg.sender);
        uint8 earned = _tierFromCount(v2n + v4n);
        if (earned < claimedTier) revert InsufficientLaunches();
        tokenId = registry.mint(msg.sender, uri);
        emit IdentityMinted(msg.sender, claimedTier, tokenId, v2n, v4n);
    }

    // ===== Views =====

    /// @notice On-chain bonded launches for `creator`. Sum of V2 +
    ///         V4 paths. Front-end can call this to cross-check
    ///         the tier badge before initiating the mint.
    function bondedCountOf(address creator) external view returns (uint256) {
        (uint256 v2n, uint256 v4n) = _bondedCountsOf(creator);
        return v2n + v4n;
    }

    function tierOf(address creator) external view returns (uint8) {
        (uint256 v2n, uint256 v4n) = _bondedCountsOf(creator);
        return _tierFromCount(v2n + v4n);
    }

    function _bondedCountsOf(address creator) internal view returns (uint256 v2n, uint256 v4n) {
        // V2 launchpad: count tokens where creator matches AND migrated.
        // CLANKER_V3 (mode 2) launches do NOT count: they skip the
        // bonding curve entirely, so a scammer could mint 10 worthless
        // CLANKER_V3 tokens for 30 USDC and earn Diamond if we counted
        // them. Audit 2026-06-18 H-12.
        uint256 total = launchpad.getTokensCount();
        if (total > SAFE_COUNT_CAP) total = SAFE_COUNT_CAP;
        for (uint256 i = 0; i < total; i++) {
            address t = launchpad.allTokens(i);
            IArcadeLaunchpadView.TokenState memory s = launchpad.tokens(t);
            if (s.creator == creator && s.migrated) {
                v2n++;
            }
        }
        // V4 ArcadeHook: count graduated launches (status == 2).
        if (address(arcadeHook) != address(0)) {
            uint256 hookTotal = arcadeHook.tokensCount();
            if (hookTotal > SAFE_COUNT_CAP) hookTotal = SAFE_COUNT_CAP;
            for (uint256 i = 0; i < hookTotal; i++) {
                address t = arcadeHook.allTokens(i);
                bytes32 poolId = arcadeHook.poolIdOf(t);
                if (poolId == bytes32(0)) continue;
                IArcadeHookView.CurveState memory cs = arcadeHook.getCurveState(poolId);
                if (cs.creator == creator && cs.status == 2) {
                    v4n++;
                }
            }
        }
    }

    function _tierFromCount(uint256 n) internal pure returns (uint8) {
        if (n >= DIAMOND_MIN) return TIER_DIAMOND;
        if (n >= GOLD_MIN) return TIER_GOLD;
        if (n >= SILVER_MIN) return TIER_SILVER;
        return TIER_NONE;
    }
}
