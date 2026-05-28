import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "My tokens",
  description: "Tokens you've launched. Claim creator fees and manage recipients.",
};

export default function MyTokensLayout({ children }: { children: React.ReactNode }) {
  return children;
}
