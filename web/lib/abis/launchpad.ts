export const LAUNCHPAD_ABI = [
  // ===== Reads =====
  {
    type: "function",
    name: "getTokensCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allTokens",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokens",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "creator", type: "address" },
      { name: "creator2", type: "address" },
      { name: "creator2ShareBps", type: "uint16" },
      { name: "mode", type: "uint8" },
      { name: "createdAt", type: "uint64" },
      { name: "migratedAt", type: "uint64" },
      { name: "migrated", type: "bool" },
      { name: "realUsdcReserve", type: "uint256" },
      { name: "tokensSold", type: "uint256" },
      { name: "v2Pair", type: "address" },
      { name: "metadataURI", type: "string" },
    ],
  },
  {
    type: "function",
    name: "getTokenState",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "creator", type: "address" },
          { name: "creator2", type: "address" },
          { name: "creator2ShareBps", type: "uint16" },
          { name: "mode", type: "uint8" },
          { name: "createdAt", type: "uint64" },
          { name: "migratedAt", type: "uint64" },
          { name: "migrated", type: "bool" },
          { name: "realUsdcReserve", type: "uint256" },
          { name: "tokensSold", type: "uint256" },
          { name: "v2Pair", type: "address" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "marketCap",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteBuy",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountUsdcIn", type: "uint256" },
    ],
    outputs: [
      { name: "tokensOut", type: "uint256" },
      { name: "refund", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteSell",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "tokensIn", type: "uint256" },
    ],
    outputs: [{ name: "usdcOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "getCommentsCount",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getComments",
    stateMutability: "view",
    inputs: [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "author", type: "address" },
          { name: "timestamp", type: "uint64" },
          { name: "text", type: "string" },
        ],
      },
    ],
  },
  // ===== Constants (exposed by `public constant`) =====
  { type: "function", name: "TOTAL_SUPPLY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "CURVE_SUPPLY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MIGRATION_USDC_TARGET", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "CREATION_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  // ===== Writes =====
  {
    type: "function",
    name: "createToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "mode", type: "uint8" },
      { name: "creator2", type: "address" },
      { name: "creator2ShareBps", type: "uint16" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountUsdcIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
    ],
    outputs: [
      { name: "tokensOut", type: "uint256" },
      { name: "usdcSpent", type: "uint256" },
      { name: "refund", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "tokensIn", type: "uint256" },
      { name: "minUsdcOut", type: "uint256" },
    ],
    outputs: [{ name: "usdcOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "postComment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "text", type: "string" },
    ],
    outputs: [],
  },

  // ===== Events =====
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "mode", type: "uint8", indexed: false },
      { name: "creator2", type: "address", indexed: false },
      { name: "creator2ShareBps", type: "uint16", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
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
  {
    type: "event",
    name: "Migrated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "pair", type: "address", indexed: true },
      { name: "usdcSeeded", type: "uint256", indexed: false },
      { name: "tokensSeeded", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CommentPosted",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "author", type: "address", indexed: true },
      { name: "index", type: "uint256", indexed: false },
      { name: "text", type: "string", indexed: false },
    ],
  },
] as const;
