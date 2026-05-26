import { defineChain } from "viem";

/**
 * Arc testnet — Circle's EVM L1. USDC is the native gas token, but it's
 * exposed to user-space as a normal ERC20 contract. We treat the in-RPC
 * "native currency" only for gas balance / fee display purposes.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: { http: ["https://5042002.rpc.thirdweb.com"] },
  },
  blockExplorers: {
    default: { name: "Arc Scan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const anvilLocal = defineChain({
  id: 31337,
  name: "Anvil Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});
