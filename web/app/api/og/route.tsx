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

/**
 * Dynamic OpenGraph image generator for token detail pages.
 *
 * Called via `/api/og?name=ARC&symbol=ARC&image=...&fdv=42500&creator=username`
 * Returns a 1200x630 PNG suitable as og:image and twitter:image.
 *
 * Keep the JSX flat. Satori chokes on overly-nested flex layouts and on
 * unsupported CSS, so every container declares display:flex explicitly and
 * the gradient lives on a single backing layer. No external font fetches:
 * the route relies on Satori's default font, which always resolves.
 */
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const name = (searchParams.get("name") ?? "Arcade Token").slice(0, 40);
    const symbol = (searchParams.get("symbol") ?? "ARC").slice(0, 12);
    const rawImage = searchParams.get("image") ?? "";
    const fdv = searchParams.get("fdv") ?? "";
    const creator = (searchParams.get("creator") ?? "").slice(0, 30);
    const variant = searchParams.get("variant") ?? "v23";

    // Only embed http(s) images. ipfs:// must already be resolved by the
    // caller (seo.ts does this); anything else falls through to the letter
    // placeholder so the route never serves a broken <img>.
    const image =
        rawImage.startsWith("https://") || rawImage.startsWith("http://")
            ? rawImage
            : "";

    return new ImageResponse(
        (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    width: "100%",
                    height: "100%",
                    background:
                        "linear-gradient(135deg, #001029 0%, #0a1e3a 50%, #15508f 100%)",
                    padding: "60px 80px",
                    color: "white",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        fontSize: 28,
                        fontWeight: 700,
                        letterSpacing: 4,
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 44,
                            height: 44,
                            borderRadius: 10,
                            background: "#2f7fd6",
                            marginRight: 14,
                            fontSize: 24,
                        }}
                    >
                        A
                    </div>
                    <div style={{ display: "flex" }}>ARCADE</div>
                    {variant === "v4" && (
                        <div
                            style={{
                                display: "flex",
                                marginLeft: 14,
                                padding: "4px 12px",
                                borderRadius: 8,
                                background: "rgba(47,127,214,0.2)",
                                fontSize: 18,
                                color: "#9ecbff",
                            }}
                        >
                            V4
                        </div>
                    )}
                </div>

                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        marginTop: 60,
                        marginBottom: 60,
                    }}
                >
                    {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={image}
                            alt=""
                            width={220}
                            height={220}
                            style={{
                                width: 220,
                                height: 220,
                                borderRadius: 28,
                                objectFit: "cover",
                                marginRight: 50,
                            }}
                        />
                    ) : (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 220,
                                height: 220,
                                borderRadius: 28,
                                background:
                                    "linear-gradient(135deg, #2f7fd6, #15508f)",
                                fontSize: 110,
                                fontWeight: 800,
                                marginRight: 50,
                            }}
                        >
                            {symbol.replace(/^\$+/, "").charAt(0) || "?"}
                        </div>
                    )}
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            maxWidth: 640,
                        }}
                    >
                        <div
                            style={{
                                display: "flex",
                                fontSize: 32,
                                color: "#9ecbff",
                                fontWeight: 600,
                            }}
                        >
                            ${symbol.replace(/^\$+/, "")}
                        </div>
                        <div
                            style={{
                                display: "flex",
                                fontSize: 64,
                                fontWeight: 700,
                                marginTop: 6,
                            }}
                        >
                            {name}
                        </div>
                        {creator && (
                            <div
                                style={{
                                    display: "flex",
                                    fontSize: 22,
                                    color: "rgba(255,255,255,0.65)",
                                    marginTop: 12,
                                }}
                            >
                                by @{creator}
                            </div>
                        )}
                    </div>
                </div>

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
                                    color: "rgba(255,255,255,0.6)",
                                    letterSpacing: 2,
                                }}
                            >
                                MARKET CAP
                            </div>
                            <div
                                style={{
                                    display: "flex",
                                    fontSize: 44,
                                    fontWeight: 700,
                                    marginTop: 4,
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
                            padding: "14px 26px",
                            borderRadius: 14,
                            background: "#2f7fd6",
                            fontSize: 22,
                            fontWeight: 600,
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
