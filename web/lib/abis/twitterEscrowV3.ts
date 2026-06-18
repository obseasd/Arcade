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
    // H-01: read these to display the timelock floor in admin UI.
    {
        type: "function",
        name: "MIN_TIMELOCK",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint64" }],
    },
    {
        type: "function",
        name: "MAX_TIMELOCK",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint64" }],
    },
    {
        type: "function",
        name: "DEFAULT_TIMELOCK",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint64" }],
    },
    {
        type: "function",
        name: "FORFEIT_DELAY",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint64" }],
    },
    {
        type: "function",
        name: "lastCreditedAt",
        stateMutability: "view",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
        ],
        outputs: [{ name: "", type: "uint64" }],
    },
    {
        type: "function",
        name: "LOCKER",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "trustedSigner",
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
        name: "creditedTotal",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
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

    // ===== Owner-gated admin writes (H-08 + M-12) =====
    {
        type: "function",
        name: "pullFromLocker",
        stateMutability: "nonpayable",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "amount", type: "uint256" }],
    },
    {
        type: "function",
        name: "rotateLockerAdmin",
        stateMutability: "nonpayable",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
            { name: "newAdmin", type: "address" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "rotateLockerRecipient",
        stateMutability: "nonpayable",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
            { name: "newRecipient", type: "address" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "setClaimTimelock",
        stateMutability: "nonpayable",
        inputs: [{ name: "newTimelock", type: "uint64" }],
        outputs: [],
    },
    {
        type: "function",
        name: "setTrustedSigner",
        stateMutability: "nonpayable",
        inputs: [{ name: "newSigner", type: "address" }],
        outputs: [],
    },
    // Audit 2026-06-18 M-13: the gen 8 contract replaced the
    // immediate setTrustedSigner with a 2-step + 24h timelock flow.
    // Without these entries, the frontend cannot even type-check a
    // call to the new path — wagmi's typed writeContract would
    // reject `functionName: "requestTrustedSignerRotation"`.
    //
    // Flow:
    //   1. requestTrustedSignerRotation(newSigner)
    //      → stages newSigner, sets trustedSignerNotBefore = now + 24h
    //   2. (optional) cancelTrustedSignerRotation() at any time
    //   3. finalizeTrustedSignerRotation() once block.timestamp >= notBefore
    //      → trustedSigner = pendingTrustedSigner, pending = 0
    {
        type: "function",
        name: "requestTrustedSignerRotation",
        stateMutability: "nonpayable",
        inputs: [{ name: "newSigner", type: "address" }],
        outputs: [],
    },
    {
        type: "function",
        name: "cancelTrustedSignerRotation",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
    },
    {
        type: "function",
        name: "finalizeTrustedSignerRotation",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
    },
    {
        type: "function",
        name: "pendingTrustedSigner",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "trustedSignerNotBefore",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint64" }],
    },
    // Error decoded by viem on the deprecated setTrustedSigner path.
    { type: "error", name: "USE_TIMELOCK_ROTATION", inputs: [] },
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
        name: "veto",
        stateMutability: "nonpayable",
        inputs: [{ name: "nonce", type: "bytes32" }],
        outputs: [],
    },
    {
        type: "function",
        name: "rescue",
        stateMutability: "nonpayable",
        inputs: [
            { name: "token", type: "address" },
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "forfeitStaleClaim",
        stateMutability: "nonpayable",
        inputs: [
            { name: "positionId", type: "uint256" },
            { name: "slotIndex", type: "uint256" },
            { name: "pairedToken", type: "address" },
            { name: "clankerToken", type: "address" },
            { name: "to", type: "address" },
        ],
        outputs: [],
    },
    // Ownable2Step: two-step ownership transfer. transferOwnership stages
    // the new owner as `pendingOwner`; the new owner must call
    // acceptOwnership() from their own wallet to finalize.
    {
        type: "function",
        name: "transferOwnership",
        stateMutability: "nonpayable",
        inputs: [{ name: "newOwner", type: "address" }],
        outputs: [],
    },
    {
        type: "function",
        name: "acceptOwnership",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
    },
    {
        type: "function",
        name: "pendingOwner",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    // M-03: this reverts with RenounceDisabled() but the ABI entry lets us
    // decode the error name cleanly if anyone ever calls it.
    {
        type: "function",
        name: "renounceOwnership",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
    },

    // ===== Errors (decoded by viem on revert) =====
    { type: "error", name: "Expired", inputs: [] },
    { type: "error", name: "AlreadyClaimed", inputs: [] },
    { type: "error", name: "NonceReused", inputs: [] },
    { type: "error", name: "InvalidSignature", inputs: [] },
    { type: "error", name: "ZeroAddress", inputs: [] },
    { type: "error", name: "NotLocker", inputs: [] },
    { type: "error", name: "LockerNotSet", inputs: [] },
    { type: "error", name: "LockerAlreadySet", inputs: [] },
    { type: "error", name: "NotAuthorized", inputs: [] },
    { type: "error", name: "Timelocked", inputs: [] },
    { type: "error", name: "TimelockTooLong", inputs: [] },
    { type: "error", name: "TimelockTooShort", inputs: [] },
    { type: "error", name: "Already", inputs: [] },
    { type: "error", name: "SlotPending", inputs: [] },
    { type: "error", name: "InsufficientBalance", inputs: [] },
    { type: "error", name: "ExceedsFreeBalance", inputs: [] },
    { type: "error", name: "InvalidTokens", inputs: [] },
    { type: "error", name: "DeadlineInPast", inputs: [] },
    { type: "error", name: "NothingToClaim", inputs: [] },
    { type: "error", name: "RenounceDisabled", inputs: [] },
    { type: "error", name: "SlotAlreadyClaimed", inputs: [] },
    { type: "error", name: "NotStaleYet", inputs: [] },

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
