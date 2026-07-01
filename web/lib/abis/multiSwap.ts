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
          // H-07: per-leg floor threaded into each leg's router call as the
          // real amountOutMinimum (closes the single-thin-leg sandwich hole).
          { name: "minOut", type: "uint256" },
          // H-07: per-leg floor for the intermediate USDC hop on via-USDC /
          // migrated routes (replaces the sandwicher-controlled inline quote).
          { name: "usdcMidMin", type: "uint256" },
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
  // Errors (so viem decodes reverts to human-readable names instead of 0x...).
  { type: "error", name: "EmptyInputs", inputs: [] },
  { type: "error", name: "TooManyInputs", inputs: [] },
  { type: "error", name: "DeadlinePassed", inputs: [] },
  { type: "error", name: "InsufficientOutput", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  // H-06: a V4 leg whose PoolKey carries a hook that isn't the launchpad's HOOK().
  { type: "error", name: "UnknownHook", inputs: [] },
  // L-09: a V4 leg pointing at a registered-but-not-initialized launch (zeroed PoolKey).
  { type: "error", name: "PoolNotInitialized", inputs: [] },
] as const;
