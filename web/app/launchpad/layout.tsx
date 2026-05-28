import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Launchpad",
  description: "Browse and launch tokens on Arc: PUMP curve, Arcade curve, and Clanker V3 locked-LP.",
};

export default function LaunchpadLayout({ children }: { children: React.ReactNode }) {
  return children;
}
