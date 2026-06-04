import type { Metadata } from "next";

export const metadata: Metadata = {
  // Page title (browser tab) uses the root template "%s on Arcade" -> "Swap on Arcade".
  title: "Swap",
  description: "Swap USDC and tokens on Arc via the Arcade V2 AMM and V3 router.",
  // Discord / X embed title: bypass the template so the bold link shows the
  // pipe-separated brand instead of "Swap on Arcade".
  openGraph: {
    title: "Arcade | Swap",
    description: "Swap USDC and tokens on Arc via the Arcade V2 AMM and V3 router.",
  },
  twitter: {
    title: "Arcade | Swap",
    description: "Swap USDC and tokens on Arc via the Arcade V2 AMM and V3 router.",
  },
};

export default function SwapLayout({ children }: { children: React.ReactNode }) {
  return children;
}
