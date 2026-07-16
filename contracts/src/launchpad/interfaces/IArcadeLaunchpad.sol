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

    /// @notice Buy a migrated token with USDC via V2. Thin wrapper: the
    /// graduated pair charges the 0.30% fee in its own K, so this skims nothing
    /// extra (the wrapper royalty this line used to name was removed).
    function buyMigrated(address tokenAddr, uint256 usdcIn, uint256 minTokensOut, uint256 deadline)
        external
        returns (uint256 tokensOut);

    /// @notice Sell a migrated token for USDC via V2. Thin wrapper: the pair
    /// charges the fee INPUT-side in its own K, so this skims nothing. This line
    /// used to say "from the USDC output" -- the reverted output-side design
    /// that silently defeats amountOutMin; the body never did it.
    function sellMigrated(address tokenAddr, uint256 tokensIn, uint256 minUsdcOut, uint256 deadline)
        external
        returns (uint256 usdcOut);

    /// @notice Multi-hop swap A -> USDC -> B. Charges no wrapper fee on either
    /// leg -- each migrated token's pair charges it in-K.
    /// @param deadline unix timestamp after which the call reverts (passed through to the V2 router on every leg).
    function swapMigratedRoute(
        address tokenIn,
        address tokenOut,
        uint256 tokensIn,
        uint256 minTokensOut,
        uint256 usdcMidMin,
        uint256 deadline
    ) external returns (uint256 tokensOut);

    /// @notice View quote for `swapMigratedRoute`, returning the expected final
    /// output and the mid-leg USDC (leg 2's input). The second value used to be
    /// "total royalty across both legs"; there is no wrapper royalty any more
    /// (each pair charges the fee in its own K), so it now carries usdcMid,
    /// which the caller needs to derive usdcMidMin.
    function quoteSwapMigratedRoute(address tokenIn, address tokenOut, uint256 tokensIn)
        external
        view
        // Second return is the mid-leg USDC (the input to leg 2), NOT a royalty:
        // the wrapper royalty is gone, each pair charges the fee in its own K.
        // Callers derive usdcMidMin from this.
        returns (uint256 tokensOut, uint256 usdcMid);
}
