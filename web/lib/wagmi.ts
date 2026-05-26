import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { arcTestnet, anvilLocal } from "./chains";

const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

const defaultChain = process.env.NEXT_PUBLIC_DEFAULT_CHAIN === "arc" ? arcTestnet : anvilLocal;

// We list Arc first when it's the default so RainbowKit highlights it.
const chains = defaultChain.id === arcTestnet.id
  ? ([arcTestnet, anvilLocal] as const)
  : ([anvilLocal, arcTestnet] as const);

export const wagmiConfig = getDefaultConfig({
  appName: "Arcade",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains,
  transports: {
    [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
    [anvilLocal.id]: http(anvilLocal.rpcUrls.default.http[0]),
  },
  ssr: true,
});

export { defaultChain };
