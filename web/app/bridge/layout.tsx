import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bridge",
  description: "Bridge USDC into Arc from Ethereum, Base, Arbitrum, Optimism, Avalanche via Circle CCTP.",
};

export default function BridgeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
