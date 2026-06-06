/**
 * ArcadeV3Zap ABI. Mirrors contracts/v3src/ArcadeV3Zap.sol. The single
 * write entrypoint is zapInMaxRange, which takes a tuple matching the
 * Solidity struct ZapParams and returns (tokenId, liquidity).
 */
export const V3_ZAP_ABI = [
    {
        type: "function",
        name: "factory",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "npm",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "zapInMaxRange",
        stateMutability: "nonpayable",
        inputs: [
            {
                name: "p",
                type: "tuple",
                components: [
                    { name: "tokenIn", type: "address" },
                    { name: "otherToken", type: "address" },
                    { name: "fee", type: "uint24" },
                    { name: "amountIn", type: "uint256" },
                    { name: "amount0Min", type: "uint256" },
                    { name: "amount1Min", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                    { name: "recipient", type: "address" },
                ],
            },
        ],
        outputs: [
            { name: "tokenId", type: "uint256" },
            { name: "liquidity", type: "uint128" },
        ],
    },
] as const;
