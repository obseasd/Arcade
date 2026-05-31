import type { Metadata } from "next";
import { buildOgImageUrl, fetchV4TokenSeo } from "@/lib/seo";

export async function generateMetadata(
    { params }: { params: Promise<{ address: string }> },
): Promise<Metadata> {
    const { address } = await params;
    const data = await fetchV4TokenSeo(address);

    if (!data) {
        return {
            title: "V4 Launch — Arcade",
            description: "Anti-sniper hook + single-sided locked LP. Trade on Arcade.",
        };
    }

    const title = `$${data.symbol} — ${data.name} · V4 on Arcade`;
    const description = `${data.name} ($${data.symbol}) — V4 launch with anti-sniper hook. Trade on Arcade.`;
    const imageUrl = buildOgImageUrl(data);

    return {
        title,
        description,
        openGraph: {
            type: "website",
            title,
            description,
            images: [
                { url: imageUrl, width: 1200, height: 630, alt: `${data.name} (${data.symbol})` },
            ],
            siteName: "Arcade",
        },
        twitter: {
            card: "summary_large_image",
            title,
            description,
            images: [imageUrl],
        },
    };
}

export default function Layout({ children }: { children: React.ReactNode }) {
    return children;
}
