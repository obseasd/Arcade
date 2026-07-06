import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { ChainGuard } from "@/components/layout/ChainGuard";
import { Toaster } from "@/components/ui/Toaster";
import { CustomScrollbar } from "@/components/ui/CustomScrollbar";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk" });

export const metadata: Metadata = {
  // metadataBase makes every relative URL in this metadata block absolute,
  // which Discord / X require to render the embed image.
  metadataBase: new URL("https://www.arcade.trading"),
  title: {
    default: "Arcade",
    template: "%s on Arcade",
  },
  description:
    "USDC-native AMM and fair-launch tokenization on Arc, Circle's EVM L1. Capital formation primitive for stablecoin-native markets: bonding-curve token issuance, AMM trading, locked-LP fee distribution.",
  icons: {
    icon: "/arcdlogo22.png",
    apple: "/arcdlogo22.png",
  },
  // Machine-discoverable pointers to the agent layer (for crawlers / agent
  // frameworks that read page metadata). Human + worked docs live at /agents.
  other: {
    "ai-plugin": "https://www.arcade.trading/.well-known/ai-plugin.json",
    "agent-api": "https://www.arcade.trading/api/agent/openapi",
    "agent-docs": "https://www.arcade.trading/agents",
  },
  openGraph: {
    title: "Arcade",
    description: "USDC-native AMM and fair-launch tokenization on Arc.",
    url: "https://www.arcade.trading",
    siteName: "Arcade",
    // /api/og/brand renders the dynamic brand splash (centered logo +
    // wordmark in Space Grotesk + dual blue bloom). Token-detail pages
    // override with the per-token /api/og embed.
    images: [{ url: "/api/og/brand", width: 1200, height: 630, alt: "Arcade" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Arcade",
    description: "USDC-native AMM and fair-launch tokenization on Arc.",
    images: ["/api/og/brand"],
    site: "@ArcadeSwap",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://www.arcade.trading/#org",
        name: "Arcade",
        url: "https://www.arcade.trading",
        logo: "https://www.arcade.trading/arcdlogo22.png",
        description: "USDC-native DEX and bonding-curve launchpad on Circle's Arc L1.",
        // sameAs strengthens the brand entity so Google links the domain to
        // its known social profiles (a signal that correlates with sitelinks
        // eligibility and a richer brand result).
        sameAs: [
          "https://x.com/ArcadeSwap",
          "https://discord.gg/NTx4Rkq2p5",
        ],
      },
      {
        "@type": "WebSite",
        "@id": "https://www.arcade.trading/#website",
        url: "https://www.arcade.trading",
        name: "Arcade",
        publisher: { "@id": "https://www.arcade.trading/#org" },
      },
      {
        "@type": "SoftwareApplication",
        name: "Arcade Agent API",
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web",
        url: "https://www.arcade.trading/agents",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        description:
          "Agent-accessible API + MCP server to trade and launch tokens on Arc with a Circle Wallet.",
      },
    ],
  };
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`} suppressHydrationWarning>
      <head>
        {/* Preconnect to the Pinata IPFS gateway so the TLS handshake +
            DNS lookup are done before the first token logo on /launchpad
            requests bytes. Saves ~150-300 ms on cold renders where 20+
            logos race to the same host. dns-prefetch is a fallback for
            browsers that ignore preconnect on third-party origins. */}
        <link rel="preconnect" href="https://gateway.pinata.cloud" crossOrigin="" />
        <link rel="dns-prefetch" href="https://gateway.pinata.cloud" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="font-sans antialiased" suppressHydrationWarning>
        <Providers>
          <div className="arc-header-glow" aria-hidden />
          <div className="relative flex min-h-screen flex-col">
            <Navbar />
            <main className="flex-1">{children}</main>
            <Footer />
          </div>
          <Toaster />
          <CustomScrollbar />
          <ChainGuard />
        </Providers>
      </body>
    </html>
  );
}
