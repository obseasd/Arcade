import type { Metadata } from "next";

export const metadata: Metadata = {
  // Page title (browser tab) uses the root template "%s on Arcade" -> "Swap on Arcade".
  title: "Swap",
  description: "Swap USDC and tokens on Arc via the Arcade V2 AMM and V3 router.",
  // Discord / X embed title: bypass the template so the bold link shows the
  // pipe-separated brand instead of "Swap on Arcade".
  // openGraph + twitter are REPLACED (not merged) when overridden in a child
  // layout, so the brand image has to be repeated here or the embed renders
  // with no preview at all.
  openGraph: {
    title: "Arcade | Swap",
    description: "Swap USDC and tokens on Arc via the Arcade V2 AMM and V3 router.",
    images: [{ url: "/api/og/brand", width: 1200, height: 630, alt: "Arcade" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Arcade | Swap",
    description: "Swap USDC and tokens on Arc via the Arcade V2 AMM and V3 router.",
    images: ["/api/og/brand"],
  },
};

export default function SwapLayout({ children }: { children: React.ReactNode }) {
  return children;
}
