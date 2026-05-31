import type { Metadata } from "next";
import { buildOgImageUrl, fetchV23TokenSeo } from "@/lib/seo";

export async function generateMetadata(
    { params }: { params: Promise<{ address: string }> },
): Promise<Metadata> {
    const { address } = await params;
    const data = await fetchV23TokenSeo(address);

    // No data → return a generic Arcade-branded preview rather than nothing,
    // so even an invalid token URL renders cleanly when shared.
    if (!data) {
        return {
            title: "Arcade Launchpad",
            description: "Launch and trade tokens on Arc's bonding-curve launchpad.",
        };
    }

    const title = `$${data.symbol} — ${data.name} on Arcade`;
    const description = data.marketCapFormatted
        ? `${data.name} ($${data.symbol}) · Market cap $${data.marketCapFormatted} · Trade on Arcade.`
        : `${data.name} ($${data.symbol}) — Trade on Arcade.`;
    const imageUrl = buildOgImageUrl(data);

    return {
        title,
        description,
        openGraph: {
            type: "website",
            title,
            description,
            images: [
                {
                    url: imageUrl,
                    width: 1200,
                    height: 630,
                    alt: `${data.name} (${data.symbol})`,
                },
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
