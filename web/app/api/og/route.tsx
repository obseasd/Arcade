import { ImageResponse } from "next/og";
import { NextRequest, NextResponse } from "next/server";

// next/og uses Satori + WASM and is officially supported on edge runtime
// in Next.js 15. Switching to nodejs broke ImageResponse construction on
// Vercel (returned a 500 HTML page with an image/png content-type header,
// which the browser rendered as blank). Keep edge.
export const runtime = "edge";
// Force-dynamic so query params get re-evaluated on every request instead
// of being statically optimized into a single cached response.
export const dynamic = "force-dynamic";

/**
 * Audit F-1: hostname allowlist for the `?image=` fetch. Satori pulls the
 * URL server-side, so without this guard the route is an unauthenticated
 * fetch proxy — an attacker can probe internal subnets, AWS metadata
 * endpoints, or pin attacker-controlled bytes into the Vercel edge cache.
 * Limit to Pinata + the official IPFS gateways we already use elsewhere,
 * plus the configured `NEXT_PUBLIC_IPFS_GATEWAY` if set. IP-literal hosts
 * and RFC1918 / link-local addresses are rejected unconditionally.
 */
const OG_IMAGE_HOST_ALLOWLIST = new Set<string>([
    "gateway.pinata.cloud",
    "ipfs.io",
    "cloudflare-ipfs.com",
    "dweb.link",
]);
function getOgEnvGateway(): string | null {
    const raw = process.env.NEXT_PUBLIC_IPFS_GATEWAY;
    if (!raw) return null;
    try {
        return new URL(raw).hostname.toLowerCase();
    } catch {
        return null;
    }
}
function isPrivateOrLocal(host: string): boolean {
    if (host === "localhost" || host.endsWith(".local")) return true;
    // RFC1918 + link-local + loopback IP4 literals.
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    // IPv6 loopback / link-local.
    if (host === "::1" || host.startsWith("fe80:")) return true;
    return false;
}
function isAllowedImageHost(rawUrl: string): boolean {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== "https:") return false;
        const host = u.hostname.toLowerCase();
        if (isPrivateOrLocal(host)) return false;
        // Allow bare IP literals never (no use case + SSRF risk).
        if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
        if (OG_IMAGE_HOST_ALLOWLIST.has(host)) return true;
        const envHost = getOgEnvGateway();
        if (envHost && host === envHost) return true;
        return false;
    } catch {
        return false;
    }
}

/**
 * Audit F-2: per-IP rate limit on /api/og. Without it an attacker can
 * burn outbound edge bandwidth + Satori CPU + cache pollution by hitting
 * the route with cache-busting `name` queries. 30 requests / minute / IP
 * comfortably covers legitimate token-share crawls (Discord, X, Telegram
 * all warm the cache once per token).
 */
const OG_RATE_LIMIT_PER_MINUTE = 30;
const ogBuckets = new Map<string, { count: number; windowStart: number }>();
function ogRateLimit(req: NextRequest): NextResponse | null {
    const ip =
        req.headers.get("x-vercel-forwarded-for") ||
        req.headers.get("x-real-ip") ||
        req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
        "unknown";
    const now = Date.now();
    const bucket = ogBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > 60_000) {
        ogBuckets.set(ip, { count: 1, windowStart: now });
        return null;
    }
    bucket.count++;
    if (bucket.count > OG_RATE_LIMIT_PER_MINUTE) {
        return new NextResponse("Rate limit exceeded", { status: 429 });
    }
    return null;
}

/**
 * Audit F-10: normalise the `?creator=` query param to a strict Twitter
 * handle shape before embedding in the OG image, so deployers can't
 * spoof attribution by passing arbitrary text that Satori would render
 * as a byline ("by @cz_binance"). Matches the same shape the server uses
 * in twitter-callback's `normaliseHandle`.
 */
function normaliseHandle(raw: string): string {
    const trimmed = raw.replace(/^@+/, "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(trimmed)) return "";
    return trimmed;
}

// Brand palette (kept in sync with tailwind.config.ts -> arc-*).
const BG_FROM = "#001029";
const BG_MID = "#0A1F3A";
const BG_TO = "#15324F";
const CTA = "#15508F"; // arc-cta-hover, the brand action blue
const CTA_DEEP = "#0E3A6A"; // arc-cta, darker stop for the gradient
const TEXT_FAINT = "rgba(229,238,248,0.55)";
const TEXT_MUTED = "rgba(146,168,194,1)";

/**
 * Resolve a query-string base for fetching local /public assets from the
 * running deployment. The OG route can be hit from anywhere (Discord, X,
 * Telegram), so we use the request's own host as the canonical origin.
 */
function originFromReq(req: NextRequest): string {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
}

/**
 * Dynamic OpenGraph image generator for token detail pages.
 *
 * Called via `/api/og?name=ARC&symbol=ARC&image=...&fdv=42500&creator=username`
 * Returns a 1200x630 PNG suitable as og:image and twitter:image.
 *
 * Keep the JSX flat. Satori chokes on overly-nested flex layouts and on
 * unsupported CSS, so every container declares display:flex explicitly.
 */
export async function GET(req: NextRequest) {
    const limited = ogRateLimit(req);
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const name = (searchParams.get("name") ?? "Arcade Token").slice(0, 40);
    const symbol = (searchParams.get("symbol") ?? "ARC").slice(0, 12);
    const rawImage = searchParams.get("image") ?? "";
    const fdv = searchParams.get("fdv") ?? "";
    // Audit F-10: normalise creator handle before embedding. Anything
    // that isn't a strict Twitter handle is silently dropped — Satori
    // then skips the byline rather than rendering attacker-chosen text.
    const creator = normaliseHandle(searchParams.get("creator") ?? "");
    const variant = searchParams.get("variant") ?? "v23";

    const cleanSymbol = symbol.replace(/^\$+/, "") || "TKN";

    // Only embed images whose hostname is on the allowlist (audit F-1).
    // ipfs:// must already be resolved by the caller (seo.ts does this);
    // anything else falls through to the letter placeholder so the route
    // never serves a broken <img> AND never acts as an SSRF proxy.
    const image = isAllowedImageHost(rawImage) ? rawImage : "";

    const origin = originFromReq(req);
    const brandLogo = `${origin}/arcdlogo22.png`;

    return new ImageResponse(
        (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    width: "100%",
                    height: "100%",
                    background: `linear-gradient(135deg, ${BG_FROM} 0%, ${BG_MID} 55%, ${BG_TO} 100%)`,
                    padding: "60px 80px",
                    color: "#E5EEF8",
                    fontFamily: "Inter, sans-serif",
                }}
            >
                {/* Brand row: real arcade.png glyph + ARCADE wordmark */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                    }}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={brandLogo}
                        alt=""
                        width={56}
                        height={56}
                        style={{
                            width: 56,
                            height: 56,
                            marginRight: 16,
                        }}
                    />
                    <div
                        style={{
                            display: "flex",
                            fontSize: 32,
                            fontWeight: 800,
                            letterSpacing: 6,
                            color: "#E5EEF8",
                        }}
                    >
                        ARCADE
                    </div>
                    {variant === "v4" && (
                        <div
                            style={{
                                display: "flex",
                                marginLeft: 18,
                                padding: "6px 14px",
                                borderRadius: 10,
                                background: "rgba(47,127,214,0.18)",
                                fontSize: 18,
                                fontWeight: 700,
                                letterSpacing: 2,
                                color: "#9ecbff",
                            }}
                        >
                            V4
                        </div>
                    )}
                </div>

                {/* Middle: token logo + name */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        marginTop: 56,
                        marginBottom: 56,
                    }}
                >
                    {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={image}
                            alt=""
                            width={240}
                            height={240}
                            style={{
                                width: 240,
                                height: 240,
                                borderRadius: 32,
                                objectFit: "cover",
                                marginRight: 56,
                                border: "2px solid rgba(255,255,255,0.12)",
                            }}
                        />
                    ) : (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 240,
                                height: 240,
                                borderRadius: 32,
                                background: `linear-gradient(135deg, ${CTA} 0%, ${CTA_DEEP} 100%)`,
                                fontSize: 130,
                                fontWeight: 800,
                                marginRight: 56,
                                color: "#E5EEF8",
                                border: "2px solid rgba(255,255,255,0.12)",
                            }}
                        >
                            {cleanSymbol.charAt(0).toUpperCase()}
                        </div>
                    )}
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            maxWidth: 660,
                        }}
                    >
                        <div
                            style={{
                                display: "flex",
                                fontSize: 34,
                                color: "#42729A",
                                fontWeight: 700,
                                letterSpacing: 2,
                            }}
                        >
                            ${cleanSymbol}
                        </div>
                        <div
                            style={{
                                display: "flex",
                                fontSize: 68,
                                fontWeight: 800,
                                marginTop: 8,
                                lineHeight: 1.05,
                            }}
                        >
                            {name}
                        </div>
                        {creator && (
                            <div
                                style={{
                                    display: "flex",
                                    fontSize: 22,
                                    color: TEXT_FAINT,
                                    marginTop: 14,
                                }}
                            >
                                by @{creator}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer: MC + CTA */}
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-end",
                        marginTop: "auto",
                    }}
                >
                    {fdv ? (
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                            }}
                        >
                            <div
                                style={{
                                    display: "flex",
                                    fontSize: 18,
                                    color: TEXT_MUTED,
                                    letterSpacing: 4,
                                    fontWeight: 600,
                                }}
                            >
                                MARKET CAP
                            </div>
                            <div
                                style={{
                                    display: "flex",
                                    fontSize: 46,
                                    fontWeight: 800,
                                    marginTop: 6,
                                }}
                            >
                                ${fdv}
                            </div>
                        </div>
                    ) : (
                        <div style={{ display: "flex" }} />
                    )}
                    <div
                        style={{
                            display: "flex",
                            padding: "16px 30px",
                            borderRadius: 14,
                            background: `linear-gradient(135deg, ${CTA} 0%, ${CTA_DEEP} 100%)`,
                            fontSize: 24,
                            fontWeight: 700,
                            color: "#E5EEF8",
                            border: "1px solid rgba(255,255,255,0.08)",
                        }}
                    >
                        Trade on Arcade
                    </div>
                </div>
            </div>
        ),
        {
            width: 1200,
            height: 630,
            headers: {
                "cache-control":
                    "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
            },
        },
    );
}
