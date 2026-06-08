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
    icon: "/Arc2logo.png",
    apple: "/Arc2logo.png",
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
    site: "@arcade",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`} suppressHydrationWarning>
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
