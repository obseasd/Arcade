// ArcadeTokenVault — locked/vesting creator allocation for CLANKER_V3 launches.
export const TOKEN_VAULT_ABI = [
  {
    type: "function",
    name: "vestIdByToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "updateRecipient",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "newRecipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getVest",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "recipient", type: "address" },
          { name: "total", type: "uint256" },
          { name: "claimed", type: "uint256" },
          { name: "lockupEnd", type: "uint64" },
          { name: "vestingEnd", type: "uint64" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;
