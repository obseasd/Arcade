export const MULTISWAP_ABI = [
  {
    type: "function",
    name: "swapToSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "inputs",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      { name: "tokenOut", type: "address" },
      { name: "minTotalOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "totalOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteSwapToSingle",
    stateMutability: "view",
    inputs: [
      {
        name: "inputs",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      { name: "tokenOut", type: "address" },
    ],
    outputs: [
      { name: "totalOut", type: "uint256" },
      { name: "perInputOut", type: "uint256[]" },
    ],
  },
  { type: "function", name: "MAX_INPUTS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "MultiSwap",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: true },
      { name: "inputsCount", type: "uint256", indexed: false },
      { name: "totalOut", type: "uint256", indexed: false },
    ],
  },
] as const;
