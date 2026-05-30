import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LP Position Simulator",
  description: "Model LP configurations and simulate how buys move the price on Arc launches.",
};

export default function LpSimulatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
