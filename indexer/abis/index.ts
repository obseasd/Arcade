/**
 * Minimal event ABIs the indexer needs. Event signatures are copied verbatim
 * from web/lib/eventSignatures.ts and contracts/lib/v3-core so the decoded
 * args line up with the price math in src/lib/price.ts.
 */

export const LaunchpadAbi = [
    {
        type: "event",
        name: "Buy",
        inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "buyer", type: "address", indexed: true },
            { name: "usdcIn", type: "uint256", indexed: false },
            { name: "tokensOut", type: "uint256", indexed: false },
            { name: "newPriceQ64", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "Sell",
        inputs: [
            { name: "token", type: "address", indexed: true },
            { name: "seller", type: "address", indexed: true },
            { name: "tokensIn", type: "uint256", indexed: false },
            { name: "usdcOut", type: "uint256", indexed: false },
            { name: "newPriceQ64", type: "uint256", indexed: false },
        ],
    },
] as const;

export const V3FactoryAbi = [
    {
        type: "event",
        name: "PoolCreated",
        inputs: [
            { name: "token0", type: "address", indexed: true },
            { name: "token1", type: "address", indexed: true },
            { name: "fee", type: "uint24", indexed: true },
            { name: "tickSpacing", type: "int24", indexed: false },
            { name: "pool", type: "address", indexed: false },
        ],
    },
] as const;

export const V3PoolAbi = [
    {
        type: "event",
        name: "Swap",
        inputs: [
            { name: "sender", type: "address", indexed: true },
            { name: "recipient", type: "address", indexed: true },
            { name: "amount0", type: "int256", indexed: false },
            { name: "amount1", type: "int256", indexed: false },
            { name: "sqrtPriceX96", type: "uint160", indexed: false },
            { name: "liquidity", type: "uint128", indexed: false },
            { name: "tick", type: "int24", indexed: false },
        ],
    },
] as const;
