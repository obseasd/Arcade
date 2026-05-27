// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArcadeLaunchpad {
    /// @notice Launch mode determines the curve fee split AND the migration style.
    /// PUMP      = 50% platform / 50% creator(s), migrates to a V2 pool with LP burned
    /// CLANKER   = 70% platform / 30% creator(s), migrates to a V2 pool with LP burned
    /// CLANKER_V3 = 70% platform / 30% creator(s) on the curve; migrates to a LOCKED
    ///             Uniswap V3 full-range position held by ArcadeV3Locker, where the
    ///             creator earns 80% of perpetual LP fees (platform 20%) and the
    ///             principal can never be withdrawn.
    enum LaunchMode {
        PUMP,
        CLANKER,
        CLANKER_V3
    }

    struct TokenState {
        address token;
        address creator; // primary fee receiver
        address creator2; // optional secondary receiver (CLANKER mode); zero address = none
        uint16 creator2ShareBps; // share of CREATOR portion that goes to creator2, in bps (0–10000)
        LaunchMode mode;
        uint64 createdAt;
        uint64 migratedAt;
        bool migrated;
        uint256 realUsdcReserve;
        uint256 tokensSold;
        address v2Pair;
        string metadataURI;
    }

    event TokenCreated(
        address indexed token,
        address indexed creator,
        LaunchMode mode,
        address creator2,
        uint16 creator2ShareBps,
        string name,
        string symbol,
        string metadataURI
    );
    event Buy(
        address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 newPriceQ64
    );
    event Sell(
        address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 newPriceQ64
    );
    event Migrated(address indexed token, address indexed pair, uint256 usdcSeeded, uint256 tokensSeeded);
    event CommentPosted(address indexed token, address indexed author, uint256 index, string text);

    /// @notice Returns true iff `tokenAddr` is a known launchpad token whose curve has migrated.
    function isMigrated(address tokenAddr) external view returns (bool);

    /// @notice Royalty-aware multi-hop swap A -> USDC -> B with launchpad royalty on each migrated leg.
    function swapMigratedRoute(
        address tokenIn,
        address tokenOut,
        uint256 tokensIn,
        uint256 minTokensOut
    ) external returns (uint256 tokensOut);

    /// @notice View quote for `swapMigratedRoute`, returning the expected
    /// output and total royalty (USDC) skimmed across both legs.
    function quoteSwapMigratedRoute(address tokenIn, address tokenOut, uint256 tokensIn)
        external
        view
        returns (uint256 tokensOut, uint256 totalRoyaltyUsdc);
}
