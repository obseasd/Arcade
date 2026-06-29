import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Stats",
    description:
        "Live protocol stats for Arcade on Arc: transactions routed, unique wallets, tokens launched, volume and USDC gas paid through Arcade contracts.",
    alternates: { canonical: "https://www.arcade.trading/stats" },
};

export default function StatsLayout({ children }: { children: React.ReactNode }) {
    return children;
}
