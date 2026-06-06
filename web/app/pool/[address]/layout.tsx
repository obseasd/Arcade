import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pool",
  description: "Pool details, recent trades, and add/remove liquidity on Arcade.",
};

export default function PoolLayout({ children }: { children: React.ReactNode }) {
  return children;
}
