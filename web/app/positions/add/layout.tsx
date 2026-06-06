import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Add Liquidity",
  description:
    "Provide liquidity to an Arcade pool with single-asset or balanced zaps for V2 and V3.",
};

export default function AddLiquidityLayout({ children }: { children: React.ReactNode }) {
  return children;
}
