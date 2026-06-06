import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "V4 Hook · Tokens",
  description: "Browse tokens minted via the V4 ArcadeHook on Arc.",
};

export default function V4HookListLayout({ children }: { children: React.ReactNode }) {
  return children;
}
