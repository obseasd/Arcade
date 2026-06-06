import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "V4 Hook Token",
  description: "Trade and inspect a V4 ArcadeHook token on Arc.",
};

export default function V4HookTokenLayout({ children }: { children: React.ReactNode }) {
  return children;
}
