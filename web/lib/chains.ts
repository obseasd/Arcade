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
    default: {
      http: ["https://rpc.testnet.arc.network"],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: { name: "Arc Scan", url: "https://testnet.arcscan.app" },
  },
  // 2026-06-17: canonical Multicall3 IS now deployed on Arc Testnet at
  // 0xcA11bde05977b3631167028862bE2a173976CA11 (confirmed via Arcscan
  // smart-contracts API, full aggregate3 implementation). Wiring it
  // here enables viem's multicall path in every useReadContracts
  // across the app, replacing the per-call eth_call fan-out we've
  // been carrying as a workaround since the prior multicall3 trap
  // (Arc had a Multicall v1 squatting on a non-canonical address —
  // see the historical context blocks below for the original mess).
  //
  // Watchdog: should the canonical Multicall3 ever start reverting
  // on aggregate3 after a node upgrade, remove this line and the
  // per-callsite reads will silently fan back out to individual
  // eth_calls — slow but correct.
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 0,
    },
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
