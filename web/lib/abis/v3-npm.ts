/**
 * Canonical Uniswap V3 NonfungiblePositionManager interface. Mirrors
 * `INonfungiblePositionManager.sol` from v3-periphery commit 80f26c8. Used
 * against ArcadeV3PositionManager, which inherits behaviour 1:1 and only
 * overrides name()/symbol()/tokenURI() for branding.
 */
export const V3_NPM_ABI = [
    {
        type: "function",
        name: "factory",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "createAndInitializePoolIfNecessary",
        stateMutability: "payable",
        inputs: [
            { name: "token0", type: "address" },
            { name: "token1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "sqrtPriceX96", type: "uint160" },
        ],
        outputs: [{ name: "pool", type: "address" }],
    },
    {
        type: "function",
        name: "mint",
        stateMutability: "payable",
        inputs: [
            {
                name: "params",
                type: "tuple",
                components: [
                    { name: "token0", type: "address" },
                    { name: "token1", type: "address" },
                    { name: "fee", type: "uint24" },
                    { name: "tickLower", type: "int24" },
                    { name: "tickUpper", type: "int24" },
                    { name: "amount0Desired", type: "uint256" },
                    { name: "amount1Desired", type: "uint256" },
                    { name: "amount0Min", type: "uint256" },
                    { name: "amount1Min", type: "uint256" },
                    { name: "recipient", type: "address" },
                    { name: "deadline", type: "uint256" },
                ],
            },
        ],
        outputs: [
            { name: "tokenId", type: "uint256" },
            { name: "liquidity", type: "uint128" },
            { name: "amount0", type: "uint256" },
            { name: "amount1", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "increaseLiquidity",
        stateMutability: "payable",
        inputs: [
            {
                name: "params",
                type: "tuple",
                components: [
                    { name: "tokenId", type: "uint256" },
                    { name: "amount0Desired", type: "uint256" },
                    { name: "amount1Desired", type: "uint256" },
                    { name: "amount0Min", type: "uint256" },
                    { name: "amount1Min", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                ],
            },
        ],
        outputs: [
            { name: "liquidity", type: "uint128" },
            { name: "amount0", type: "uint256" },
            { name: "amount1", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "decreaseLiquidity",
        stateMutability: "payable",
        inputs: [
            {
                name: "params",
                type: "tuple",
                components: [
                    { name: "tokenId", type: "uint256" },
                    { name: "liquidity", type: "uint128" },
                    { name: "amount0Min", type: "uint256" },
                    { name: "amount1Min", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                ],
            },
        ],
        outputs: [
            { name: "amount0", type: "uint256" },
            { name: "amount1", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "collect",
        stateMutability: "payable",
        inputs: [
            {
                name: "params",
                type: "tuple",
                components: [
                    { name: "tokenId", type: "uint256" },
                    { name: "recipient", type: "address" },
                    { name: "amount0Max", type: "uint128" },
                    { name: "amount1Max", type: "uint128" },
                ],
            },
        ],
        outputs: [
            { name: "amount0", type: "uint256" },
            { name: "amount1", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "burn",
        stateMutability: "payable",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [],
    },
    {
        type: "function",
        name: "positions",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [
            { name: "nonce", type: "uint96" },
            { name: "operator", type: "address" },
            { name: "token0", type: "address" },
            { name: "token1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickLower", type: "int24" },
            { name: "tickUpper", type: "int24" },
            { name: "liquidity", type: "uint128" },
            { name: "feeGrowthInside0LastX128", type: "uint256" },
            { name: "feeGrowthInside1LastX128", type: "uint256" },
            { name: "tokensOwed0", type: "uint128" },
            { name: "tokensOwed1", type: "uint128" },
        ],
    },
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "tokenOfOwnerByIndex",
        stateMutability: "view",
        inputs: [
            { name: "owner", type: "address" },
            { name: "index", type: "uint256" },
        ],
        outputs: [{ type: "uint256" }],
    },
] as const;

/**
 * V3 pool ABI. Re-exported from ./v3, which holds the single canonical superset
 * (this file previously kept a trimmed 6-member copy; merged so callers here get
 * the same slot0/liquidity/tickSpacing/fee/token0/token1 PLUS the pending-fee
 * math members feeGrowthGlobal0/1X128 / ticks() / positions() with no drift).
 *
 * Note: the NPM also inherits Multicall.sol (bundle collect()/decreaseLiquidity()
 * into ONE tx). We deliberately do NOT expose `multicall(bytes[])` in an ABI here
 * because wagmi v2's typed writeContract excludes bytes[]-returning Multicall
 * calls; ClaimAllFeesModal encodes the multicall calldata inline and sends it via
 * walletClient.sendTransaction instead.
 */
export { V3_POOL_ABI } from "./v3";

export const V3_FACTORY_ABI = [
    {
        type: "function",
        name: "getPool",
        stateMutability: "view",
        inputs: [
            { type: "address" },
            { type: "address" },
            { type: "uint24" },
        ],
        outputs: [{ type: "address" }],
    },
] as const;
