import { defineChain } from "viem";
import {
  sepolia,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
  avalancheFuji,
} from "viem/chains";

/**
 * Arc testnet - Circle's EVM L1. USDC is the native gas token, but it's
 * exposed to user-space as a normal ERC20 contract.
 */
export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
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

// Re-export CCTP source chains so wagmi config can register them.
export { sepolia, baseSepolia, arbitrumSepolia, optimismSepolia, avalancheFuji };
