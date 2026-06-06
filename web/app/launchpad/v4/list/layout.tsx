import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "V4 Launches",
  description: "Browse V4-prototype launchpad tokens powered by Uniswap V4 hooks.",
};

export default function V4ListLayout({ children }: { children: React.ReactNode }) {
  return children;
}
