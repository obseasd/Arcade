/** ABI for ArcadeTwitterEscrow. Holds Clanker LP fees attributed to a Twitter
 *  @handle and releases them on a backend-signed EIP-712 claim. */
export const TWITTER_ESCROW_ABI = [
  {
    type: "function",
    name: "LOCKER",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "TRUSTED_SIGNER",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "slotIndex", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "nonceUsed",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "slotIndex", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "pairedToken", type: "address" },
      { name: "pairedAmount", type: "uint256" },
      { name: "clankerToken", type: "address" },
      { name: "clankerAmount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "positionId", type: "uint256", indexed: true },
      { name: "slotIndex", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "pairedToken", type: "address", indexed: false },
      { name: "pairedAmount", type: "uint256", indexed: false },
      { name: "clankerToken", type: "address", indexed: false },
      { name: "clankerAmount", type: "uint256", indexed: false },
    ],
  },
] as const;
