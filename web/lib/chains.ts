import { defineChain } from "viem";
import {
  sepolia,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
  avalancheFuji,
  mainnet as ethereumMainnet,
  base,
  arbitrum,
  optimism,
  avalanche,
} from "viem/chains";

/**
 * Arc is Circle's EVM L1. USDC is the native gas token, exposed to user-space as
 * a normal ERC20 contract. Both environments share the canonical Multicall3 at
 * 0xcA11bde05977b3631167028862bE2a173976CA11 (verified deployed on testnet AND
 * mainnet 2026-07-2x), which enables viem's multicall path across the app.
 *
 * SOFT MAINNET SWITCH: the whole app targets `arcTestnet` (kept as the exported
 * name for the ~24 call sites), but that name is an ALIAS of `arcActive`, which
 * is selected from NEXT_PUBLIC_ARC_ENV. Flipping that one var to "mainnet" (plus
 * re-pointing the NEXT_PUBLIC_* address envs to the mainnet generation) switches
 * every chain-bound client, guard, and explorer link with no code change. RPC
 * and explorer are env-overridable so no redeploy is needed to swap an endpoint.
 */
const IS_MAINNET = (process.env.NEXT_PUBLIC_ARC_ENV ?? "").toLowerCase() === "mainnet";

const ARC_MULTICALL3 = {
  multicall3: {
    address: "0xcA11bde05977b3631167028862bE2a173976CA11" as const,
    blockCreated: 0,
  },
};

/** Arc testnet (chainId 5042002). */
export const arcTestnetChain = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: { name: "Arc Scan", url: "https://testnet.arcscan.app" },
  },
  contracts: ARC_MULTICALL3,
  testnet: true,
});

/**
 * Arc mainnet (chainId 5042). Values verified on-chain 2026-07-17: native USDC
 * at 0x3600...0000 (symbol "USDC", 6 dec), Multicall3 deployed at the canonical
 * address, CCTP V2 MessageTransmitter.localDomain() == 26. The public block
 * explorer URL is not known yet (arcscan.app / explorer.arc.network do not
 * resolve for mainnet), so it is left empty and env-overridable; an empty
 * explorer is rendered gracefully (links are only shown when a URL is set).
 */
export const arcMainnetChain = defineChain({
  id: 5_042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL ?? "https://5042.rpc.thirdweb.com"],
      // No public mainnet WS endpoint is known yet; leave it empty (env-
      // overridable). Consumers fall back to http polling when it is empty.
      webSocket: process.env.NEXT_PUBLIC_ARC_MAINNET_WS_URL
        ? [process.env.NEXT_PUBLIC_ARC_MAINNET_WS_URL]
        : [],
    },
  },
  blockExplorers: {
    default: {
      name: "Arc Scan",
      url: process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL ?? "",
    },
  },
  contracts: ARC_MULTICALL3,
  testnet: false,
});

/** The Arc chain the app targets, selected by NEXT_PUBLIC_ARC_ENV. */
export const arcActive = IS_MAINNET ? arcMainnetChain : arcTestnetChain;

/**
 * Backward-compatible alias. Every call site imports `arcTestnet` and uses it as
 * "the active Arc chain" (wagmi registration, ChainGuard, client builders,
 * explorer links). Aliasing it to `arcActive` makes the mainnet switch a single
 * env flip with zero changes at those call sites.
 */
export const arcTestnet = arcActive;

export const anvilLocal = defineChain({
  id: 31337,
  name: "Anvil Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

// Re-export CCTP source chains so wagmi config can register them.
// Testnet: Sepolia variants. Mainnet: real L1s.
// Base leads so it is the default source chain (BridgeCard reads [0]) and heads
// the picker: most Arc bridge inflow comes from Base, and its fees/latency are
// the lightest of the CCTP set.
export const cctpSourceChains = IS_MAINNET
  ? [base, ethereumMainnet, arbitrum, optimism, avalanche]
  : [baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, avalancheFuji];
