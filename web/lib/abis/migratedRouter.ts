// ABI for ArcadeMigratedRouter — the post-migration trading wrappers
// (buyMigrated / sellMigrated / swapMigratedRoute + its quote) EXTRACTED from
// ArcadeLaunchpad to bring the launchpad back under the EIP-170 24,576-byte
// limit. Same signatures as before; only the target contract moved. The
// usdcMidMin mid-leg sandwich guard and the CLANKER_V3 rejection are intact
// on-chain, so callers must still pass a real usdcMidMin (never 0) on the
// token<->token route.
export const MIGRATED_ROUTER_ABI = [
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
      // The real mid-leg USDC (leg 2's input), NOT a royalty. Callers derive
      // usdcMidMin from this (typically 97%); passing 0 re-opens the sandwich.
      { name: "usdcMid", type: "uint256" },
    ],
  },
] as const;
