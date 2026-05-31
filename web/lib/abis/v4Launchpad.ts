/**
 * Minimal ABI for ArcadeV4Launchpad. Subset of the contract surface the V4
 * launch wizard touches: createLaunch, initializePool, the two view helpers
 * (previewPosition + poolAllocation), and a couple of read constants. Mirrors
 * the upstream interface in contracts/v4src/ArcadeV4Launchpad.sol.
 */
export const V4_LAUNCHPAD_ABI = [
    // --- Read constants --------------------------------------------------
    {
        type: "function",
        name: "CREATION_FEE",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "TOTAL_SUPPLY",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "TICK_SPACING",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "int24" }],
    },
    {
        type: "function",
        name: "POOL_FEE",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint24" }],
    },

    // --- Token registry --------------------------------------------------
    {
        type: "function",
        name: "tokensCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "allTokens",
        stateMutability: "view",
        inputs: [{ name: "", type: "uint256" }],
        outputs: [{ name: "", type: "address" }],
    },

    // --- Launch flow -----------------------------------------------------
    {
        type: "function",
        name: "createLaunch",
        stateMutability: "nonpayable",
        inputs: [
            { name: "name", type: "string" },
            { name: "symbol", type: "string" },
            { name: "metadataURI", type: "string" },
            { name: "snipeStartBps", type: "uint16" },
            { name: "snipeDecaySeconds", type: "uint32" },
            { name: "creatorBps", type: "uint16" },
        ],
        outputs: [{ name: "tokenAddr", type: "address" }],
    },
    {
        type: "function",
        name: "initializePool",
        stateMutability: "nonpayable",
        inputs: [
            { name: "token", type: "address" },
            { name: "sqrtPriceX96", type: "uint160" },
            { name: "liquidityDelta", type: "int128" },
        ],
        outputs: [],
    },

    // --- Views the wizard needs -----------------------------------------
    {
        type: "function",
        name: "getLaunch",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "token", type: "address" },
                    { name: "creator", type: "address" },
                    {
                        name: "poolKey",
                        type: "tuple",
                        components: [
                            { name: "currency0", type: "address" },
                            { name: "currency1", type: "address" },
                            { name: "fee", type: "uint24" },
                            { name: "tickSpacing", type: "int24" },
                            { name: "hooks", type: "address" },
                        ],
                    },
                    { name: "snipeStartBps", type: "uint16" },
                    { name: "snipeDecaySeconds", type: "uint32" },
                    { name: "launchedAt", type: "uint64" },
                    { name: "creatorBps", type: "uint16" },
                ],
            },
        ],
    },
    {
        type: "function",
        name: "previewPosition",
        stateMutability: "view",
        inputs: [
            { name: "token", type: "address" },
            { name: "currentTick", type: "int24" },
        ],
        outputs: [
            { name: "tickLower", type: "int24" },
            { name: "tickUpper", type: "int24" },
            { name: "tokenIsCurrency0", type: "bool" },
        ],
    },
    {
        type: "function",
        name: "poolAllocation",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "currentSnipeBps",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "treasury",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },

    // --- Events the indexer + wizard watch -------------------------------
    {
        type: "event",
        name: "TokenLaunched",
        inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "creator", type: "address", indexed: true },
            { name: "snipeStartBps", type: "uint16", indexed: false },
            { name: "snipeDecaySeconds", type: "uint32", indexed: false },
            { name: "launchedAt", type: "uint64", indexed: false },
            { name: "creatorBps", type: "uint16", indexed: false },
            { name: "name", type: "string", indexed: false },
            { name: "symbol", type: "string", indexed: false },
            { name: "metadataURI", type: "string", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "PoolInitialized",
        inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "pool", type: "address", indexed: true },
            { name: "sqrtPriceX96", type: "uint160", indexed: false },
            { name: "tickLower", type: "int24", indexed: false },
            { name: "tickUpper", type: "int24", indexed: false },
            { name: "liquidityDelta", type: "int256", indexed: false },
        ],
        anonymous: false,
    },
] as const;
