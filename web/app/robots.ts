import type { MetadataRoute } from "next";

// Cost-control robots policy (2026-07-07).
//
// Context: on Vercel EVERY inbound request counts as an Edge Request,
// including CDN cache hits for static chunks and OG images. The launchpad
// exposes 1000+ per-token pages (each = one RSC document + ~30-50 chunk/
// font/image sub-requests + one OG image). Left fully open, aggressive
// SEO/AI scrapers recrawl that whole surface continuously and burned
// ~5M edge requests in 30 days (5x the Hobby cap -> account paused).
//
// Policy:
//   - Real search engines (Google / Bing / DuckDuckGo) keep FULL access to
//     the HTML pages so the SEO/sitelinks goal is unaffected. Only /api/ is
//     off-limits to them (API routes are function calls, useless to index).
//   - Pure-leech SEO crawlers and AI scrapers that provide ZERO search value
//     are blocked outright. This is the bulk of the wasted traffic.
//   - Everyone else: pages allowed, /api/ disallowed.
//
// All of this is reversible. To let an AI crawler back in (e.g. to appear in
// ChatGPT/Claude answers), remove its userAgent from BLOCKED_BOTS.
const BLOCKED_BOTS = [
    // SEO backlink crawlers (no search traffic, very aggressive)
    "AhrefsBot",
    "SemrushBot",
    "MJ12bot",
    "DotBot",
    "DataForSeoBot",
    "BLEXBot",
    "PetalBot",
    "Barkrowler",
    "SeekportBot",
    // Generic scrapers / spam
    "Bytespider",
    "serpstatbot",
    "ZoominfoBot",
    // AI training crawlers (reversible: drop from this list to opt back in)
    "GPTBot",
    "ClaudeBot",
    "anthropic-ai",
    "CCBot",
    "Google-Extended",
    "Applebot-Extended",
    "Amazonbot",
    "Meta-ExternalAgent",
    "cohere-ai",
    "PerplexityBot",
];

export default function robots(): MetadataRoute.Robots {
    return {
        rules: [
            // Real search engines: full page access, API off-limits.
            {
                userAgent: ["Googlebot", "Bingbot", "DuckDuckBot"],
                allow: "/",
                disallow: "/api/",
            },
            // Parasitic SEO + AI scrapers: blocked entirely.
            { userAgent: BLOCKED_BOTS, disallow: "/" },
            // Everyone else: pages allowed, API disallowed.
            { userAgent: "*", allow: "/", disallow: "/api/" },
        ],
        sitemap: "https://www.arcade.trading/sitemap.xml",
    };
}
