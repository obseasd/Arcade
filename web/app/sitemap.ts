import type { MetadataRoute } from "next";

const base = "https://www.arcade.trading";

export default function sitemap(): MetadataRoute.Sitemap {
    return [
        { url: base, priority: 1 },
        { url: `${base}/api/agent/openapi`, priority: 0.9 },
        { url: `${base}/llms.txt`, priority: 0.8 },
        { url: `${base}/.well-known/ai-plugin.json`, priority: 0.8 },
    ];
}
