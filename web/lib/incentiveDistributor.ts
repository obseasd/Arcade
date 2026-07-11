import { Address } from "viem";

/**
 * ArcadeIncentiveDistributor — escrow-backed liquidity-incentive campaigns
 * (Merkl-style). createCampaign pulls the full reward into escrow; a trusted
 * operator posts cumulative Merkle roots; LPs claim their delta; the creator
 * reclaims the remainder after the window + a 3-day grace.
 *
 * Root building (operator side, off-chain): use OpenZeppelin's
 * StandardMerkleTree with leaf encoding ["address","uint256"] and values
 * [account, cumulativeAmount]. That library's default leaf hashing
 * (double keccak of the abi-encoded tuple) matches the on-chain `claim`.
 */
export const INCENTIVE_DISTRIBUTOR_ABI = [
    {
        type: "function",
        name: "createCampaign",
        stateMutability: "nonpayable",
        inputs: [
            { name: "pool", type: "address" },
            { name: "rewardToken", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "start", type: "uint64" },
            { name: "end", type: "uint64" },
        ],
        outputs: [{ name: "id", type: "uint256" }],
    },
    {
        type: "function",
        name: "setRoot",
        stateMutability: "nonpayable",
        inputs: [
            { name: "id", type: "uint256" },
            { name: "root", type: "bytes32" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "claim",
        stateMutability: "nonpayable",
        inputs: [
            { name: "id", type: "uint256" },
            { name: "account", type: "address" },
            { name: "cumulativeAmount", type: "uint256" },
            { name: "proof", type: "bytes32[]" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "reclaim",
        stateMutability: "nonpayable",
        inputs: [{ name: "id", type: "uint256" }],
        outputs: [],
    },
    {
        type: "function",
        name: "campaignCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "claimed",
        stateMutability: "view",
        inputs: [
            { name: "id", type: "uint256" },
            { name: "account", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "claimable",
        stateMutability: "view",
        inputs: [
            { name: "id", type: "uint256" },
            { name: "account", type: "address" },
            { name: "cumulativeAmount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "campaigns",
        stateMutability: "view",
        inputs: [{ name: "id", type: "uint256" }],
        outputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "creator", type: "address" },
                    { name: "pool", type: "address" },
                    { name: "rewardToken", type: "address" },
                    { name: "total", type: "uint256" },
                    { name: "distributed", type: "uint256" },
                    { name: "start", type: "uint64" },
                    { name: "end", type: "uint64" },
                    { name: "root", type: "bytes32" },
                    { name: "reclaimed", type: "bool" },
                ],
            },
        ],
    },
    {
        type: "event",
        name: "CampaignCreated",
        inputs: [
            { name: "id", type: "uint256", indexed: true },
            { name: "creator", type: "address", indexed: true },
            { name: "pool", type: "address", indexed: true },
            { name: "rewardToken", type: "address", indexed: false },
            { name: "amount", type: "uint256", indexed: false },
            { name: "start", type: "uint64", indexed: false },
            { name: "end", type: "uint64", indexed: false },
        ],
    },
    {
        type: "event",
        name: "Claimed",
        inputs: [
            { name: "id", type: "uint256", indexed: true },
            { name: "account", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
] as const;

export interface CampaignView {
    creator: Address;
    pool: Address;
    rewardToken: Address;
    total: bigint;
    distributed: bigint;
    start: bigint;
    end: bigint;
    root: `0x${string}`;
    reclaimed: boolean;
}
