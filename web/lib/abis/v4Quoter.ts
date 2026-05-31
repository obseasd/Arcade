/**
 * Minimal ABI for V4Quoter from @uniswap/v4-periphery. Used to quote a swap
 * off-chain before submitting it through ArcadeV4SwapRouter.
 *
 * The functions are NOT marked `view` upstream (they internally self-call a
 * state-modifying entry that reverts to revert any side effects). Off-chain
 * we call them with viem's `simulateContract` / wagmi's useSimulateContract.
 */
export const V4_QUOTER_ABI = [
    {
        type: "function",
        name: "quoteExactInputSingle",
        stateMutability: "nonpayable",
        inputs: [
            {
                name: "params",
                type: "tuple",
                components: [
                    {
                        name: "poolKey",
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
                    { name: "exactAmount", type: "uint128" },
                    { name: "hookData", type: "bytes" },
                ],
            },
        ],
        outputs: [
            { name: "amountOut", type: "uint256" },
            { name: "gasEstimate", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "quoteExactOutputSingle",
        stateMutability: "nonpayable",
        inputs: [
            {
                name: "params",
                type: "tuple",
                components: [
                    {
                        name: "poolKey",
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
                    { name: "exactAmount", type: "uint128" },
                    { name: "hookData", type: "bytes" },
                ],
            },
        ],
        outputs: [
            { name: "amountIn", type: "uint256" },
            { name: "gasEstimate", type: "uint256" },
        ],
    },
] as const;
