/**
 * ArcadeV3Zap ABI. Mirrors contracts/v3src/ArcadeV3Zap.sol after the 2026-06-06
 * audit pass: caller-signed slippage on every entrypoint, narrow-range zapIn
 * alongside the max-range shorthand, single-asset zapOut, and a quoteZap view
 * for the UI pre-sign breakdown.
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
                    { name: "amountOtherMinSwap", type: "uint256" },
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
    {
        type: "function",
        name: "zapIn",
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
                    { name: "amountOtherMinSwap", type: "uint256" },
                    { name: "amount0Min", type: "uint256" },
                    { name: "amount1Min", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                    { name: "recipient", type: "address" },
                ],
            },
            { name: "tickLower", type: "int24" },
            { name: "tickUpper", type: "int24" },
        ],
        outputs: [
            { name: "tokenId", type: "uint256" },
            { name: "liquidity", type: "uint128" },
        ],
    },
    {
        type: "function",
        name: "zapOut",
        stateMutability: "nonpayable",
        inputs: [
            {
                name: "p",
                type: "tuple",
                components: [
                    { name: "tokenId", type: "uint256" },
                    { name: "liquidity", type: "uint128" },
                    { name: "tokenOut", type: "address" },
                    { name: "amountOtherMinSwap", type: "uint256" },
                    { name: "amountOutMin", type: "uint256" },
                    { name: "amount0DecreaseMin", type: "uint256" },
                    { name: "amount1DecreaseMin", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                    { name: "recipient", type: "address" },
                ],
            },
        ],
        outputs: [{ name: "amountOut", type: "uint256" }],
    },
    {
        type: "function",
        name: "quoteZap",
        stateMutability: "view",
        inputs: [
            {
                name: "i",
                type: "tuple",
                components: [
                    { name: "tokenIn", type: "address" },
                    { name: "otherToken", type: "address" },
                    { name: "fee", type: "uint24" },
                    { name: "amountIn", type: "uint256" },
                    { name: "tickLower", type: "int24" },
                    { name: "tickUpper", type: "int24" },
                ],
            },
        ],
        outputs: [
            {
                name: "q",
                type: "tuple",
                components: [
                    { name: "swapAmount", type: "uint256" },
                    { name: "expectedOut", type: "uint256" },
                    { name: "expectedAmount0", type: "uint256" },
                    { name: "expectedAmount1", type: "uint256" },
                    { name: "expectedLiquidity", type: "uint128" },
                ],
            },
        ],
    },
] as const;
