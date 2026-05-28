import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Swap",
  description: "Swap USDC and tokens on Arc via the Arcade V2 AMM and V3 router.",
};

export default function SwapLayout({ children }: { children: React.ReactNode }) {
  return children;
}
