/**
 * ABI for ArcadeIdentityIssuer — the on-chain wrapper that gates
 * ERC-8004 Identity NFT mints behind a real tier check against the
 * V2 launchpad + V4 ArcadeHook bonded-launch counters.
 *
 * Wired post-deploy via NEXT_PUBLIC_ARCADE_IDENTITY_ISSUER_ADDRESS.
 * When unset, the front-end falls back to direct Registry.mint
 * (legacy testnet behavior; tier gate is client-side only).
 *
 * Source: contracts/src/identity/ArcadeIdentityIssuer.sol
 */

export const ARCADE_IDENTITY_ISSUER_ABI = [
    {
        type: "function",
        name: "mint",
        stateMutability: "nonpayable",
        inputs: [
            { name: "claimedTier", type: "uint8" },
            { name: "uri", type: "string" },
        ],
        outputs: [{ name: "tokenId", type: "uint256" }],
    },
    {
        type: "function",
        name: "bondedCountOf",
        stateMutability: "view",
        inputs: [{ name: "creator", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "tierOf",
        stateMutability: "view",
        inputs: [{ name: "creator", type: "address" }],
        outputs: [{ name: "", type: "uint8" }],
    },
    {
        type: "function",
        name: "SILVER_MIN",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "GOLD_MIN",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "DIAMOND_MIN",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "event",
        name: "IdentityMinted",
        inputs: [
            { name: "creator", type: "address", indexed: true },
            { name: "tier", type: "uint8", indexed: true },
            { name: "tokenId", type: "uint256", indexed: false },
            { name: "v2BondedCount", type: "uint256", indexed: false },
            { name: "v4BondedCount", type: "uint256", indexed: false },
        ],
    },
    { type: "error", name: "TierMismatch", inputs: [] },
    { type: "error", name: "InsufficientLaunches", inputs: [] },
    { type: "error", name: "InvalidTier", inputs: [] },
    { type: "error", name: "NotOwner", inputs: [] },
] as const;
