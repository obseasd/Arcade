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
    // marketCap() prices CIRCULATING supply, not TOTAL_SUPPLY (migrated tokens
    // burn ~60M to DEAD). Any consumer deriving a price from mcap MUST divide
    // by this, or it reads ~6.4% low on every migrated token.
    type: "function",
    name: "circulatingSupply",
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
      { name: "actualGrossPaid", type: "uint256" },
      { name: "refund", type: "uint256" },
    ],
  },
  // Pull-payment ledger for USDC payouts that failed inline (eg a
  // recipient on the Circle blacklist). Read the balance; call
  // `claimPendingUsdc` to withdraw.
  {
    type: "function",
    name: "pendingUsdcWithdrawals",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ type: "uint256" }],
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
  { type: "function", name: "CREATION_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // H-05: platform fee skimmed at migration (2,500 USDC). LP seed = realUsdcReserve - MIGRATION_FEE.
  { type: "function", name: "MIGRATION_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MIGRATION_LP_TOKENS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

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
    name: "createClankerV3",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      {
        name: "recipients",
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "admin", type: "address" },
          { name: "bps", type: "uint16" },
          { name: "tokenPref", type: "uint8" },
        ],
      },
      // ABI-encoded ClankerOptions (passed as bytes to keep the external
      // calldata decoder within via_ir's stack budget):
      //   (uint24 fee, uint256 creatorBuyUsdc, uint16 vaultPct,
      //    uint64 vaultLockupDuration, uint64 vaultVestingDuration,
      //    address vaultRecipient, uint16 snipeStartBps, uint32 snipeDecaySeconds)
      { name: "optsData", type: "bytes" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "currentSnipeBps",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
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
    name: "buyMigrated",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "usdcIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sellMigrated",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "tokensIn", type: "uint256" },
      { name: "minUsdcOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "usdcOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "swapMigratedRoute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "tokensIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "usdcMidMin", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
  // Pull-payment withdrawal: claim USDC the caller is credited with from
  // failed inline payouts (eg a previous trade's fee transfer reverted).
  {
    type: "function",
    name: "claimPendingUsdc",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteSwapMigratedRoute",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "tokensIn", type: "uint256" },
    ],
    outputs: [
      { name: "tokensOut", type: "uint256" },
      { name: "totalRoyaltyUsdc", type: "uint256" },
    ],
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
  // Emitted when a direct USDC payout failed and the amount was credited to
  // the pull-payment ledger instead. The recipient should be prompted to call
  // `claimPendingUsdc`.
  {
    type: "event",
    name: "UsdcCredited",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UsdcPendingClaimed",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;
