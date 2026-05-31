/**
 * Minimal ABI for ArcadeV4SwapRouter. Subset the frontend needs:
 * exactInputSingle / exactOutputSingle + the SwapExecuted event for the
 * post-swap toast.
 */
export const V4_ROUTER_ABI = [
    {
        type: "function",
        name: "exactInputSingle",
        stateMutability: "nonpayable",
        inputs: [
            {
                name: "key",
                type: "tuple",
                components: [
                    { name: "currency0", type: "address" },
                    { name: "currency1", type: "address" },
                    { name: "fee", type: "uint24" },
                    { name: "tickSpacing", type: "int24" },
                    { name: "hooks", type: "address" },
                ],
            },
            { name: "zeroForOne", type: "bool" },
            { name: "amountIn", type: "uint256" },
            { name: "minAmountOut", type: "uint256" },
            { name: "recipient", type: "address" },
            { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        outputs: [{ name: "amountOut", type: "uint256" }],
    },
    {
        type: "function",
        name: "exactOutputSingle",
        stateMutability: "nonpayable",
        inputs: [
            {
                name: "key",
                type: "tuple",
                components: [
                    { name: "currency0", type: "address" },
                    { name: "currency1", type: "address" },
                    { name: "fee", type: "uint24" },
                    { name: "tickSpacing", type: "int24" },
                    { name: "hooks", type: "address" },
                ],
            },
            { name: "zeroForOne", type: "bool" },
            { name: "amountOut", type: "uint256" },
            { name: "maxAmountIn", type: "uint256" },
            { name: "recipient", type: "address" },
            { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        outputs: [{ name: "amountIn", type: "uint256" }],
    },
    {
        type: "event",
        name: "SwapExecuted",
        anonymous: false,
        inputs: [
            { name: "payer", type: "address", indexed: true },
            { name: "recipient", type: "address", indexed: true },
            { name: "inputCurrency", type: "address", indexed: true },
            { name: "outputCurrency", type: "address", indexed: false },
            { name: "amountIn", type: "uint256", indexed: false },
            { name: "amountOut", type: "uint256", indexed: false },
            { name: "zeroForOne", type: "bool", indexed: false },
        ],
    },
] as const;
