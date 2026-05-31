/**
 * Minimal ABI for `ArcadeTwitterEscrowV3`. The v2 abi (`./twitterEscrow.ts`)
 * exposes the legacy single-tx `claim(...)` path; v3 removed that entirely
 * in favour of `authorize(...)` + `claimByTwitter(nonce)`. EIP-712 typehash
 * is identical so the same backend signature works.
 */
export const TWITTER_ESCROW_V3_ABI = [
    // ===== Reads =====
    {
        type: "function",
        name: "claimed",
        stateMutability: "view",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
    {
        type: "function",
        name: "claimTimelock",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint64" }],
    },
    {
        type: "function",
        name: "balances",
        stateMutability: "view",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
            { name: "token", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "paused",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "bool" }],
    },
    {
        type: "function",
        name: "pendingClaims",
        stateMutability: "view",
        inputs: [{ name: "nonce", type: "bytes32" }],
        outputs: [
            { name: "recipient", type: "address" },
            { name: "pairedToken", type: "address" },
            { name: "pairedAmount", type: "uint256" },
            { name: "clankerToken", type: "address" },
            { name: "clankerAmount", type: "uint256" },
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
            { name: "executeAfter", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "consumed", type: "bool" },
            { name: "vetoed", type: "bool" },
        ],
    },

    // ===== Writes =====
    {
        type: "function",
        name: "authorize",
        stateMutability: "nonpayable",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
            { name: "recipient", type: "address" },
            { name: "pairedToken", type: "address" },
            { name: "pairedAmount", type: "uint256" },
            { name: "clankerToken", type: "address" },
            { name: "clankerAmount", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "nonce", type: "bytes32" },
            { name: "signature", type: "bytes" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "claimByTwitter",
        stateMutability: "nonpayable",
        inputs: [{ name: "nonce", type: "bytes32" }],
        outputs: [],
    },

    // ===== Events =====
    {
        type: "event",
        name: "Authorized",
        anonymous: false,
        inputs: [
            { name: "nonce", type: "bytes32", indexed: true },
            { name: "positionId", type: "uint256", indexed: true },
            { name: "slotIndex", type: "uint256", indexed: true },
            { name: "executeAfter", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "Claimed",
        anonymous: false,
        inputs: [
            { name: "positionId", type: "uint256", indexed: true },
            { name: "slotIndex", type: "uint256", indexed: true },
            { name: "recipient", type: "address", indexed: true },
            { name: "pairedToken", type: "address", indexed: false },
            { name: "pairedAmount", type: "uint256", indexed: false },
            { name: "clankerToken", type: "address", indexed: false },
            { name: "clankerAmount", type: "uint256", indexed: false },
        ],
    },
] as const;
