import type { MetadataRoute } from "next";
import { arc } from "@/lib/agent/arcade";
import { ADDRESSES } from "@/lib/constants";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";

const base = "https://www.arcade.trading";

// Re-read the token list at most hourly so the sitemap covers new launches
// without hammering the RPC on every crawl.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const staticUrls: MetadataRoute.Sitemap = [
        { url: base, priority: 1, changeFrequency: "daily" },
        { url: `${base}/swap`, priority: 0.9, changeFrequency: "daily" },
        { url: `${base}/launchpad`, priority: 0.9, changeFrequency: "daily" },
        { url: `${base}/explore`, priority: 0.8, changeFrequency: "daily" },
        { url: `${base}/earn`, priority: 0.8, changeFrequency: "daily" },
        { url: `${base}/stats`, priority: 0.7, changeFrequency: "daily" },
        { url: `${base}/docs`, priority: 0.7, changeFrequency: "weekly" },
        { url: `${base}/bridge`, priority: 0.6 },
        { url: `${base}/positions`, priority: 0.6 },
        { url: `${base}/my-tokens`, priority: 0.6, changeFrequency: "daily" },
        { url: `${base}/lp-simulator`, priority: 0.5, changeFrequency: "weekly" },
        { url: `${base}/agents`, priority: 0.95, changeFrequency: "weekly" },
        { url: `${base}/api/agent/openapi`, priority: 0.7 },
        { url: `${base}/llms.txt`, priority: 0.6 },
    ];

    // Every launchpad token gets its own indexable page (each already has unique
    // generateMetadata). This is the long-tail SEO surface for a DEX.
    let tokenUrls: MetadataRoute.Sitemap = [];
    try {
        const count = Number(
            (await arc.readContract({
                address: ADDRESSES.launchpad,
                abi: LAUNCHPAD_ABI,
                functionName: "getTokensCount",
            })) as bigint,
        );
        const addrs = (await Promise.all(
            Array.from({ length: count }, (_, i) =>
                arc
                    .readContract({
                        address: ADDRESSES.launchpad,
                        abi: LAUNCHPAD_ABI,
                        functionName: "allTokens",
                        args: [BigInt(i)],
                    })
                    .catch(() => null),
            ),
        )) as (string | null)[];
        tokenUrls = addrs
            .filter((a): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a))
            .map((a) => ({ url: `${base}/launchpad/${a}`, priority: 0.6, changeFrequency: "daily" as const }));
    } catch {
        // RPC blip: still serve the static sitemap.
    }

    return [...staticUrls, ...tokenUrls];
}
