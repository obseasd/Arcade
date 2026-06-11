import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { mainnet } from "wagmi/chains";
import {
  arcTestnet,
  anvilLocal,
  sepolia,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
  avalancheFuji,
} from "./chains";

const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

const defaultChain = process.env.NEXT_PUBLIC_DEFAULT_CHAIN === "arc" ? arcTestnet : anvilLocal;

// Arc/Anvil first (depending on env), then the CCTP source chains so users can
// bridge USDC in from Ethereum L1, Base, Arbitrum, Optimism, Avalanche.
// mainnet is included read-only so wagmi's useEnsAddress / useEnsName can
// resolve `name.eth` recipients in the Send modal - those hooks REQUIRE
// the chain to be configured in wagmi, even if the user never switches to it.
const allChains = [arcTestnet, anvilLocal, sepolia, baseSepolia, arbitrumSepolia, optimismSepolia, avalancheFuji, mainnet] as const;
const chains = defaultChain.id === arcTestnet.id
  ? ([arcTestnet, ...allChains.filter((c) => c.id !== arcTestnet.id)] as const)
  : ([anvilLocal, ...allChains.filter((c) => c.id !== anvilLocal.id)] as const);

export const wagmiConfig = getDefaultConfig({
  appName: "Arcade",
  projectId: WALLETCONNECT_PROJECT_ID,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chains: chains as any,
  transports: {
    [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
    [anvilLocal.id]: http(anvilLocal.rpcUrls.default.http[0]),
    [sepolia.id]: http(),
    [baseSepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [optimismSepolia.id]: http(),
    [avalancheFuji.id]: http(),
    // Explicit public RPC for mainnet ENS reads. See safeMainnetRpc()
    // below for the full story - tl;dr: llamarpc.com is on every major
    // ad-blocker's privacy filter list and a blocked mainnet transport
    // hangs the entire wagmi onMount/connect chain, freezing all Arc
    // reads. publicnode.com is the same shape used by Rabby/RainbowKit
    // defaults and is not on standard block lists. The env override is
    // gated on https scheme so a mis-set / hostile vendor value
    // (javascript:, http:, custom proto) can never silently leak the
    // user's address to an attacker-controlled endpoint - audit
    // finding UI-C-1.
    [mainnet.id]: http(safeMainnetRpc()),
  },
  ssr: true,
});

function safeMainnetRpc(): string {
  // Audit 2026-06-11 v4 - ROOT CAUSE of frozen wagmi reads:
  // eth.llamarpc.com is on the default block lists for Brave Shields,
  // uBlock Origin's privacy filter, AdGuard's tracking filter, and
  // similar ad-blockers (they classify llamarpc.com as wallet-tracking
  // infrastructure). When that mainnet RPC is blocked
  // (ERR_BLOCKED_BY_CLIENT), wagmi v2's WagmiProvider.onMount call
  // chain `connect -> getChainId` hangs waiting on the mainnet
  // transport, which transitively breaks the entire connector init,
  // leaving every useReadContract hook stuck in pending state. The
  // user sees zero RPC calls to Arc despite a healthy Arc transport,
  // a connected wallet, and correct chainId pins.
  //
  // ethereum-rpc.publicnode.com is not on the standard block lists,
  // has higher uptime than llamarpc, and is the same endpoint shape
  // Rabby + RainbowKit defaults use.
  const fallback = "https://ethereum-rpc.publicnode.com";
  const raw = process.env.NEXT_PUBLIC_MAINNET_RPC;
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

export { defaultChain };
