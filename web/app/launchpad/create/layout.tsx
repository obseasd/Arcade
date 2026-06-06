import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create a token",
  description:
    "Launch a fair-launch token on Arc with bonding-curve pricing and locked-LP graduation.",
};

export default function CreateTokenLayout({ children }: { children: React.ReactNode }) {
  return children;
}
