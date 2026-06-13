/**
 * ArcadeAutoCompounder ABI — manually transcribed from
 * contracts/v3src/ArcadeAutoCompounder.sol. Wagmi consumes this as a
 * literal `const` for full type-safety on the read/write hooks; the
 * V3-profile artifact path is not exported through the V3 NPM build
 * the rest of the frontend already reads, so we maintain a thin
 * standalone copy here.
 *
 * When the contract is edited, re-export the relevant signature lines
 * from `out-v3/ArcadeAutoCompounder.sol/ArcadeAutoCompounder.json`'s
 * `abi` field and replace the block below 1:1.
 */
export const AUTO_COMPOUNDER_ABI = [
    {
        type: "function",
        name: "configs",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [
            { name: "depositor", type: "address" },
            { name: "mode", type: "uint8" },
            { name: "maxSlippageBps", type: "uint16" },
            { name: "lastActionAt", type: "uint64" },
            { name: "minFeeMicros", type: "uint64" },
        ],
    },
    {
        type: "function",
        name: "depositPosition",
        stateMutability: "nonpayable",
        inputs: [
            { name: "tokenId", type: "uint256" },
            { name: "mode", type: "uint8" },
            { name: "minFeeMicros", type: "uint64" },
            { name: "maxSlippageBps", type: "uint16" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "withdrawPosition",
        stateMutability: "nonpayable",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [],
    },
    {
        type: "function",
        name: "setMode",
        stateMutability: "nonpayable",
        inputs: [
            { name: "tokenId", type: "uint256" },
            { name: "mode", type: "uint8" },
            { name: "minFeeMicros", type: "uint64" },
            { name: "maxSlippageBps", type: "uint16" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "compound",
        stateMutability: "nonpayable",
        inputs: [
            { name: "tokenId", type: "uint256" },
            { name: "amount0Min", type: "uint256" },
            { name: "amount1Min", type: "uint256" },
            { name: "maxAcceptableProtocolFeeBps", type: "uint16" },
            { name: "deadline", type: "uint256" },
        ],
        outputs: [
            { name: "liquidityAdded", type: "uint128" },
            { name: "amount0Used", type: "uint256" },
            { name: "amount1Used", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "pushFees",
        stateMutability: "nonpayable",
        inputs: [
            { name: "tokenId", type: "uint256" },
            { name: "maxAcceptableProtocolFeeBps", type: "uint16" },
            { name: "deadline", type: "uint256" },
        ],
        outputs: [
            { name: "amount0", type: "uint256" },
            { name: "amount1", type: "uint256" },
        ],
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
    {
        type: "function",
        name: "paused",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "bool" }],
    },
    {
        type: "function",
        name: "pendingFees",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [
            { name: "fees0", type: "uint256" },
            { name: "fees1", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "nextActionAvailableAt",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "uint64" }],
    },
    {
        type: "function",
        name: "protocolFeeBps",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint16" }],
    },
    {
        type: "event",
        name: "PositionDeposited",
        inputs: [
            { name: "tokenId", type: "uint256", indexed: true },
            { name: "depositor", type: "address", indexed: true },
            { name: "mode", type: "uint8", indexed: false },
            { name: "minFeeMicros", type: "uint64", indexed: false },
            { name: "maxSlippageBps", type: "uint16", indexed: false },
        ],
    },
    {
        type: "event",
        name: "PositionWithdrawn",
        inputs: [
            { name: "tokenId", type: "uint256", indexed: true },
            { name: "to", type: "address", indexed: true },
        ],
    },
    {
        type: "event",
        name: "Compounded",
        inputs: [
            { name: "tokenId", type: "uint256", indexed: true },
            { name: "caller", type: "address", indexed: true },
            { name: "fee0Collected", type: "uint256", indexed: false },
            { name: "fee1Collected", type: "uint256", indexed: false },
            { name: "protocolFee0", type: "uint256", indexed: false },
            { name: "protocolFee1", type: "uint256", indexed: false },
            { name: "liquidityAdded", type: "uint128", indexed: false },
            { name: "amount0Used", type: "uint256", indexed: false },
            { name: "amount1Used", type: "uint256", indexed: false },
            { name: "amount0Leftover", type: "uint256", indexed: false },
            { name: "amount1Leftover", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "FeesPushed",
        inputs: [
            { name: "tokenId", type: "uint256", indexed: true },
            { name: "caller", type: "address", indexed: true },
            { name: "recipient", type: "address", indexed: true },
            { name: "amount0", type: "uint256", indexed: false },
            { name: "amount1", type: "uint256", indexed: false },
            { name: "protocolFee0", type: "uint256", indexed: false },
            { name: "protocolFee1", type: "uint256", indexed: false },
        ],
    },
] as const;

export const COMPOUNDER_MODE_NORMAL = 0 as const;
export const COMPOUNDER_MODE_RECEIVE = 1 as const;
export const COMPOUNDER_MODE_COMPOUND = 2 as const;

export type CompounderModeId = 0 | 1 | 2;

export function modeLabelFromId(id: CompounderModeId): "NORMAL" | "RECEIVE" | "COMPOUND" {
    if (id === COMPOUNDER_MODE_RECEIVE) return "RECEIVE";
    if (id === COMPOUNDER_MODE_COMPOUND) return "COMPOUND";
    return "NORMAL";
}

export function modeIdFromLabel(label: "NORMAL" | "RECEIVE" | "COMPOUND"): CompounderModeId {
    if (label === "RECEIVE") return COMPOUNDER_MODE_RECEIVE;
    if (label === "COMPOUND") return COMPOUNDER_MODE_COMPOUND;
    return COMPOUNDER_MODE_NORMAL;
}
