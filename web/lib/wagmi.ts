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
    [mainnet.id]: http(),
  },
  ssr: true,
});

export { defaultChain };
