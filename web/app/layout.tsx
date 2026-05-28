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
  title: {
    default: "Arcade",
    template: "%s on Arcade",
  },
  description:
    "Swap stablecoins and launch tokens on Arc, Circle's EVM L1. Bonding-curve launchpad and Uniswap V3 locked-LP launches, USDC-quoted.",
  icons: {
    icon: "/arcade.png",
    apple: "/arcade.png",
  },
  openGraph: {
    title: "Arcade",
    description: "DEX and token launchpad on Arc.",
    url: "https://arcade.trading",
    siteName: "Arcade",
    images: ["/arcade.png"],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Arcade",
    description: "DEX and token launchpad on Arc.",
    images: ["/arcade.png"],
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
