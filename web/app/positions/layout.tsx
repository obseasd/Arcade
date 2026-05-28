import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Positions",
  description: "Manage your V2 LP positions and claim creator LP fees on Arcade.",
};

export default function PositionsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
