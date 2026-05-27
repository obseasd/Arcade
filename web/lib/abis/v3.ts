// ABIs for Arcade's Uniswap V3 layer (CLANKER_V3 tokens).
// The quoter functions are declared `view` here so wagmi treats them as reads;
// on-chain they're non-view (they use the revert trick) but eth_call simulates
// them fine and returns the value.

export const V3_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "exactInputThroughUsdc",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const V3_QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteExactInputThroughUsdc",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const V3_LOCKER_ABI = [
  {
    type: "function",
    name: "positionIdByToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "collectFees",
    stateMutability: "nonpayable",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "pairedAmount", type: "uint256" },
      { name: "clankerAmount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "updateRecipient",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "index", type: "uint256" },
      { name: "newRecipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateAdmin",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "index", type: "uint256" },
      { name: "newAdmin", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getRecipients",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "admin", type: "address" },
          { name: "bps", type: "uint16" },
          { name: "tokenPref", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getPosition",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "pool", type: "address" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "clankerToken", type: "address" },
          { name: "pairedToken", type: "address" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

export const V3_POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
] as const;
