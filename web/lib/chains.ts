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
  // Audit A-3 (REVERTED 2026-06-11): the contract at
  // 0xe139b61c9B8Eebf32bb335cb11AA6B7Cd69e13f4 is NOT Multicall3 - it's
  // Multicall (v1). Its dispatch only routes selectors:
  //   - 0x0f28c97d getCurrentBlockTimestamp()
  //   - 0x1749e1e3 aggregate((address,bytes)[])  <- v1
  //   - 0x4d2301cc getEthBalance(address)
  // wagmi v2 + viem call aggregate3 (selector 0x82ad56cb) for every
  // batched read, which Multicall v1 does not implement -> REVERTS the
  // entire batch -> every useReadContract on the page silently fails
  // with "execution reverted". This is the root cause of the frozen
  // reads across /swap, /launchpad, /positions.
  // Until a real Multicall3 is deployed on Arc (canonical CREATE2 at
  // 0xcA11bde05977b3631167028862bE2a173976CA11), leave this unset so
  // wagmi falls back to individual eth_calls. Slightly more RPC load
  // per keystroke, but reads actually return.
  // contracts: { multicall3: { address: "0xe139...e13f4", blockCreated: 0 } },
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
