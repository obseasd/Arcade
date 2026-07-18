/**
 * ABI for ArcadeHook — the V4 Uniswap hook that subsumes the V2 launchpad +
 * V3 locker stack. Lives at `contracts/v4src/ArcadeHook.sol`.
 *
 * Surface covered:
 *   - createLaunch (PUMP / CLANKER / CLANKER_V3 modes)
 *   - buy / sell on the bonding curve (Curving phase only)
 *   - getCurveState / getFeeOwner / snipeConfigs / poolIdOf for indexer reads
 *   - All events the frontend + ArcLens indexer will subscribe to
 *   - Owner controls (pause, setTreasury, setTwitterEscrow)
 *
 * NOT covered (defer until needed):
 *   - The V4 hook callbacks themselves (beforeSwap, afterSwap, etc). These
 *     are called by the PoolManager, never by the frontend.
 *   - Public position storage reads. Indexers will inspect events instead.
 */
export const ARCADE_HOOK_ABI = [
    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------
    {
        type: "function",
        name: "USDC",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "POOL_MANAGER",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "LOCKED_VAULT",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "TREASURY",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "twitterEscrow",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "owner",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "paused",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "bool" }],
    },

    // ---------------------------------------------------------------
    // Token registry
    // ---------------------------------------------------------------
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
    {
        type: "function",
        name: "registeredLaunches",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "bool" }],
    },
    {
        type: "function",
        name: "poolIdOf",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "bytes32" }],
    },

    // ---------------------------------------------------------------
    // Per-pool state reads
    //
    // CurveState packs (virtualUsdcReserve, realUsdcReserve, tokensSold,
    // mode, status, creator, creator2, creator2Bps).
    // FeeOwner packs (creator, creator2, creator2Bps, feeTierBps,
    // twitterEscrow, slotIndex).
    // ---------------------------------------------------------------
    {
        type: "function",
        name: "getCurveState",
        stateMutability: "view",
        inputs: [{ name: "poolId", type: "bytes32" }],
        outputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "virtualUsdcReserve", type: "uint128" },
                    { name: "realUsdcReserve", type: "uint128" },
                    { name: "tokensSold", type: "uint128" },
                    { name: "mode", type: "uint8" },
                    { name: "status", type: "uint8" },
                    { name: "creator", type: "address" },
                    { name: "creator2", type: "address" },
                    { name: "creator2Bps", type: "uint16" },
                ],
            },
        ],
    },
    {
        type: "function",
        name: "getFeeOwner",
        stateMutability: "view",
        inputs: [{ name: "poolId", type: "bytes32" }],
        outputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "creator", type: "address" },
                    { name: "creator2", type: "address" },
                    { name: "creator2Bps", type: "uint16" },
                    { name: "feeTierBps", type: "uint16" },
                    { name: "twitterEscrow", type: "address" },
                    { name: "slotIndex", type: "uint8" },
                ],
            },
        ],
    },

    // ---------------------------------------------------------------
    // Anti-sniper config
    // ---------------------------------------------------------------
    {
        type: "function",
        name: "snipeConfigs",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [
            { name: "startBps", type: "uint16" },
            { name: "decaySeconds", type: "uint32" },
            { name: "launchedAt", type: "uint64" },
        ],
    },
    {
        type: "function",
        name: "currentSnipeBps",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        // Live post-graduation trading fee (bps): PUMP decays 1% -> 0.30% with
        // market cap; CLANKER returns its fixed tier. 0 before graduation.
        type: "function",
        name: "currentFeeBps",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        // The V4 pool fee (in hundredths of a bip, 1e6 = 100%) for a launch's
        // pool. PUMP = 0 (hook captures the whole fee); CLANKER = the tier
        // (10000/20000/30000 for 1/2/3%). Needed to rebuild the PoolKey.
        type: "function",
        name: "poolFeeOf",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "uint24" }],
    },
    {
        // CLANKER single-sided locked-LP position range per token. `seeded`
        // true means a direct launch was seeded and collectFees can run.
        type: "function",
        name: "clankerPos",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [
            { name: "tickLower", type: "int24" },
            { name: "tickUpper", type: "int24" },
            { name: "seeded", type: "bool" },
        ],
    },
    {
        // Harvest the CLANKER locked position's accrued LP fees (both currencies)
        // and split 80/20 creator(or escrow)/treasury. Anyone may call; funds
        // only ever route to the configured recipients. Reverts unless seeded.
        type: "function",
        name: "collectFees",
        stateMutability: "nonpayable",
        inputs: [{ name: "token", type: "address" }],
        outputs: [],
    },
    {
        // CSEC-001 pull-payment escape hatch. If a fee/anti-sniper recipient is
        // ever blocklisted for USDC, its funds accrue here instead of bricking
        // the swap; the recipient (or the escrow) pulls them later.
        type: "function",
        name: "pendingTokenWithdrawals",
        stateMutability: "view",
        inputs: [
            { name: "token", type: "address" },
            { name: "account", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "claimPendingToken",
        stateMutability: "nonpayable",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "amount", type: "uint256" }],
    },
    // ---------------------------------------------------------------
    // Events the frontend + indexer subscribe to.
    // ---------------------------------------------------------------
    {
        type: "event",
        name: "FeeAttributedToHandle",
        inputs: [
            { name: "poolId", type: "bytes32", indexed: true },
            { name: "escrow", type: "address", indexed: true },
            { name: "handle", type: "string", indexed: false },
        ],
    },
    {
        type: "event",
        name: "EscrowCreditFailed",
        inputs: [
            { name: "positionId", type: "uint256", indexed: true },
            { name: "slot", type: "uint8", indexed: false },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "TokenCredited",
        inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "recipient", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "TokenPendingClaimed",
        inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "recipient", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },

    // ---------------------------------------------------------------
    // Writes — launch flow
    //
    // mode: 0 = PUMP (bonding curve -> graduates ~$60k; post-grad dynamic fee
    // decaying 1% -> 0.30% with market cap), 1 = CLANKER (DIRECT single-sided
    // locked-LP launch at startMcapUsdc, no curve; fixed native pool LP fee tier
    // 1/2/3% via feeTier, harvested by collectFees). 2 = CLANKER_V3 is rejected.
    // Fees split 80% creator / 20% protocol for both live modes.
    // startMcapUsdc: CLANKER only (the launch FDV in USDC, 1e6); PUMP ignores it.
    // ---------------------------------------------------------------
    {
        type: "function",
        name: "createLaunch",
        stateMutability: "nonpayable",
        inputs: [
            { name: "name", type: "string" },
            { name: "symbol", type: "string" },
            { name: "metadataURI", type: "string" },
            { name: "mode", type: "uint8" },
            { name: "creator2", type: "address" },
            { name: "creator2Bps", type: "uint16" },
            { name: "snipeStartBps", type: "uint16" },
            { name: "snipeDecaySeconds", type: "uint32" },
            { name: "feeTier", type: "uint8" },
            { name: "twitterHandle", type: "string" },
            { name: "startMcapUsdc", type: "uint256" },
        ],
        outputs: [
            { name: "tokenAddr", type: "address" },
            { name: "poolId", type: "bytes32" },
        ],
    },

    // ---------------------------------------------------------------
    // Writes — curve trades (Curving phase only)
    // ---------------------------------------------------------------
    {
        type: "function",
        name: "buy",
        stateMutability: "nonpayable",
        inputs: [
            { name: "token", type: "address" },
            { name: "amountIn", type: "uint256" },
            { name: "minTokensOut", type: "uint256" },
        ],
        outputs: [
            { name: "tokensOut", type: "uint256" },
            { name: "actualGross", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "sell",
        stateMutability: "nonpayable",
        inputs: [
            { name: "token", type: "address" },
            { name: "tokensIn", type: "uint256" },
            { name: "minUsdcOut", type: "uint256" },
        ],
        outputs: [{ name: "usdcOut", type: "uint256" }],
    },

    // ---------------------------------------------------------------
    // Owner controls
    // ---------------------------------------------------------------
    {
        type: "function",
        name: "pause",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
    },
    {
        type: "function",
        name: "unpause",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
    },
    {
        type: "function",
        name: "setTreasury",
        stateMutability: "nonpayable",
        inputs: [{ name: "newTreasury", type: "address" }],
        outputs: [],
    },
    {
        type: "function",
        name: "setTwitterEscrow",
        stateMutability: "nonpayable",
        inputs: [{ name: "newEscrow", type: "address" }],
        outputs: [],
    },

    // ---------------------------------------------------------------
    // Events the frontend + ArcLens indexer subscribe to
    // ---------------------------------------------------------------
    {
        type: "event",
        name: "TokenLaunched",
        inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "creator", type: "address", indexed: true },
            { name: "mode", type: "uint8", indexed: false },
            { name: "name", type: "string", indexed: false },
            { name: "symbol", type: "string", indexed: false },
            { name: "metadataURI", type: "string", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "LaunchCreated",
        inputs: [
            { name: "poolId", type: "bytes32", indexed: true },
            { name: "token", type: "address", indexed: true },
            { name: "creator", type: "address", indexed: false },
            { name: "mode", type: "uint8", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "CurveBuy",
        inputs: [
            { name: "poolId", type: "bytes32", indexed: true },
            { name: "buyer", type: "address", indexed: true },
            { name: "grossUsdcIn", type: "uint256", indexed: false },
            { name: "tokensOut", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "CurveSell",
        inputs: [
            { name: "poolId", type: "bytes32", indexed: true },
            { name: "seller", type: "address", indexed: true },
            { name: "tokensIn", type: "uint256", indexed: false },
            { name: "usdcOut", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Graduated",
        inputs: [
            { name: "poolId", type: "bytes32", indexed: true },
            { name: "finalUsdcReserve", type: "uint256", indexed: false },
            { name: "tokensInLP", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "RoyaltyPaid",
        inputs: [
            { name: "poolId", type: "bytes32", indexed: true },
            { name: "creator", type: "address", indexed: true },
            { name: "creatorAmount", type: "uint256", indexed: false },
            { name: "treasuryAmount", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        // Emitted by collectFees when a CLANKER locked position's accrued LP
        // fees are harvested. positionKey = the pool id; amounts are the raw
        // fees pulled (currency0, currency1) before the 80/20 split.
        type: "event",
        name: "FeeHarvested",
        inputs: [
            { name: "positionKey", type: "bytes32", indexed: true },
            { name: "amount0", type: "uint256", indexed: false },
            { name: "amount1", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "AntiSnipeApplied",
        inputs: [
            { name: "poolId", type: "bytes32", indexed: true },
            { name: "sniper", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
            { name: "bps", type: "uint16", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "SnipeConfigured",
        inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "startBps", type: "uint16", indexed: false },
            { name: "decaySeconds", type: "uint32", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "PositionLocked",
        inputs: [
            { name: "positionKey", type: "bytes32", indexed: true },
            { name: "owner", type: "address", indexed: true },
            { name: "liquidity", type: "uint128", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "EscrowCreditFailed",
        inputs: [
            { name: "positionId", type: "uint256", indexed: true },
            { name: "slot", type: "uint8", indexed: false },
            { name: "amount", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "TreasuryUpdated",
        inputs: [
            { name: "oldTreasury", type: "address", indexed: true },
            { name: "newTreasury", type: "address", indexed: true },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "TwitterEscrowUpdated",
        inputs: [
            { name: "oldEscrow", type: "address", indexed: true },
            { name: "newEscrow", type: "address", indexed: true },
        ],
        anonymous: false,
    },
] as const;

/**
 * Launch mode enum mirroring `ArcadeHook.LaunchMode`. Use these constants
 * instead of magic numbers when calling createLaunch.
 */
export const ARCADE_HOOK_MODE = {
    PUMP: 0,
    CLANKER: 1,
    CLANKER_V3: 2,
} as const;

export type ArcadeHookMode = (typeof ARCADE_HOOK_MODE)[keyof typeof ARCADE_HOOK_MODE];

/**
 * Curve status enum mirroring `ArcadeHook.Status`. Use these constants when
 * reading curveStates[poolId].status to branch UI between curving, locked
 * mid-graduation, and graduated states.
 */
export const ARCADE_HOOK_STATUS = {
    CURVING: 0,
    GRADUATION_STARTED: 1,
    GRADUATED: 2,
} as const;

export type ArcadeHookStatus = (typeof ARCADE_HOOK_STATUS)[keyof typeof ARCADE_HOOK_STATUS];
