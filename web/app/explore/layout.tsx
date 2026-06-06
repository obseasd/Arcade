import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Explore",
  description:
    "Browse every Arcade pool with live TVL, APR snapshots, and 1-day volume across V2 and V3.",
  openGraph: {
    title: "Arcade | Explore pools",
    description:
      "Browse every Arcade pool with live TVL, APR snapshots, and 1-day volume across V2 and V3.",
    images: [{ url: "/api/og/brand", width: 1200, height: 630, alt: "Arcade" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Arcade | Explore pools",
    description:
      "Browse every Arcade pool with live TVL, APR snapshots, and 1-day volume.",
    images: ["/api/og/brand"],
  },
};

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  return children;
}
