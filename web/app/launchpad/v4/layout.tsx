import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "V4 Launchpad",
  description: "Prototype Uniswap V4 launchpad with anti-sniper hooks on Arc.",
};

export default function V4LaunchpadLayout({ children }: { children: React.ReactNode }) {
  return children;
}
