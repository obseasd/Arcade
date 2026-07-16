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

    /// @notice On-chain state for a launched token. `metadataURI` is intentionally
    ///         NOT stored here. It is emitted in `TokenCreated` only; the frontend
    ///         reads it from the event log. Storing rich metadata in state
    ///         would cost ~5M+ gas per launch in cold SSTORE on Arc, which
    ///         pushes Standard Clanker launches over the per-tx ceiling.
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

    /// @notice Full on-chain state for a launched token (routers read `.mode`
    /// for V3-vs-V2 routing).
    function getTokenState(address tokenAddr) external view returns (TokenState memory);

    // buyMigrated / sellMigrated / swapMigratedRoute / quoteSwapMigratedRoute
    // were EXTRACTED to ArcadeMigratedRouter (a periphery contract) to bring
    // ArcadeLaunchpad back under the EIP-170 24,576-byte limit. The logic --
    // including the usdcMidMin mid-leg sandwich guard and the CLANKER_V3
    // rejection -- is byte-identical there; only the address moved. Callers
    // (MultiSwap, the frontend) target the router, not the launchpad.
}
