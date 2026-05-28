import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Twitter claim",
  description: "Verify your Twitter @handle to claim creator fees attributed to you on Arcade.",
};

export default function ClaimLayout({ children }: { children: React.ReactNode }) {
  return children;
}
