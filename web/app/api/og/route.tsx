import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

// next/og uses Satori + WASM and is officially supported on edge runtime
// in Next.js 15. Switching to nodejs broke ImageResponse construction on
// Vercel (returned a 500 HTML page with an image/png content-type header,
// which the browser rendered as blank). Keep edge.
export const runtime = "edge";
// Force-dynamic so query params get re-evaluated on every request instead
// of being statically optimized into a single cached response.
export const dynamic = "force-dynamic";

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
    const { searchParams } = new URL(req.url);
    const name = (searchParams.get("name") ?? "Arcade Token").slice(0, 40);
    const symbol = (searchParams.get("symbol") ?? "ARC").slice(0, 12);
    const rawImage = searchParams.get("image") ?? "";
    const fdv = searchParams.get("fdv") ?? "";
    const creator = (searchParams.get("creator") ?? "").slice(0, 30);
    const variant = searchParams.get("variant") ?? "v23";

    const cleanSymbol = symbol.replace(/^\$+/, "") || "TKN";

    // Only embed http(s) images. ipfs:// must already be resolved by the
    // caller (seo.ts does this); anything else falls through to the letter
    // placeholder so the route never serves a broken <img>.
    const image =
        rawImage.startsWith("https://") || rawImage.startsWith("http://")
            ? rawImage
            : "";

    const origin = originFromReq(req);
    const brandLogo = `${origin}/arcade.png`;

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
                            padding: "16px 28px",
                            borderRadius: 14,
                            background: `linear-gradient(135deg, ${CTA} 0%, ${CTA_DEEP} 100%)`,
                            fontSize: 24,
                            fontWeight: 700,
                            color: "#E5EEF8",
                            boxShadow: "0 14px 20px -4px rgba(21, 80, 143, 0.6)",
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
