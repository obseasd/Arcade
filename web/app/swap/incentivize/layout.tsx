import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Incentivize liquidity",
  description:
    "Reward liquidity providers of an Arcade pool with USDC incentives over a fixed window.",
};

export default function IncentivizeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
