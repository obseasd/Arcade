/**
 * ArcadeTwitterEscrowV4, the V4-hook fee escrow (single-token, keyed by
 * uint256(poolId)). Distinct from the V3 escrow (dual paired+clanker, keyed by
 * the v3Locker's positionIdByToken): the V4 Claim struct has 7 fields and the
 * EIP-712 domain version is "4". Used by the V4 claim path (twitterClaimV4.ts +
 * the /claim page's v4 branch).
 */
export const TWITTER_ESCROW_V4_ABI = [
    {
        type: "function",
        name: "authorize",
        stateMutability: "nonpayable",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
            { name: "recipient", type: "address" },
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
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
        name: "claimTimelock",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
] as const;

/** EIP-712 typed-data definition for a V4 escrow Claim (matches CLAIM_TYPEHASH). */
export const TWITTER_ESCROW_V4_DOMAIN_VERSION = "4";
export const TWITTER_ESCROW_V4_CLAIM_TYPES = {
    Claim: [
        { name: "positionId", type: "uint256" },
        { name: "slotIndex", type: "uint256" },
        { name: "recipient", type: "address" },
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "bytes32" },
    ],
} as const;
