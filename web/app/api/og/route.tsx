import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

// IMPORTANT: do NOT switch to edge runtime. It silently fails on Vercel
// for this project (returns a blank 200), even though the same code works
// in dev. Node.js runtime is slower per cold-start but reliable.
export const runtime = "nodejs";
// Force-dynamic so query params get re-evaluated on every request instead
// of being statically optimized into a single cached response.
export const dynamic = "force-dynamic";

/**
 * Dynamic OpenGraph image generator for token detail pages.
 *
 * Called via `/api/og?name=ARC&symbol=ARC&image=...&fdv=42500&creator=username`
 * Returns a 1200x630 PNG suitable as og:image and twitter:image.
 *
 * Wrapped in try/catch so any rendering issue (eg a broken upstream
 * image fetch) falls back to a minimal branded image instead of blanking
 * the whole share preview on Discord / X.
 */
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const name = (searchParams.get("name") ?? "Arcade Token").slice(0, 40);
        const symbol = (searchParams.get("symbol") ?? "ARC").slice(0, 12);
        const rawImage = searchParams.get("image") ?? "";
        const fdv = searchParams.get("fdv") ?? "";
        const creator = (searchParams.get("creator") ?? "").slice(0, 30);
        const variant = searchParams.get("variant") ?? "v23";

        // Only embed http(s) images. ipfs:// must already be resolved by
        // the caller (seo.ts does this); anything else is dropped to the
        // letter fallback so we never serve a broken <img>.
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
                        fontFamily: "system-ui, sans-serif",
                        color: "white",
                        position: "relative",
                    }}
                >
                    {/* Header brand */}
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "12px",
                            fontSize: "24px",
                            fontWeight: 600,
                            letterSpacing: "0.05em",
                            color: "rgba(255,255,255,0.85)",
                        }}
                    >
                        <div
                            style={{
                                width: "36px",
                                height: "36px",
                                borderRadius: "8px",
                                background:
                                    "linear-gradient(135deg, #2f7fd6, #15508f)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "20px",
                                fontWeight: 800,
                            }}
                        >
                            A
                        </div>
                        <span>ARCADE</span>
                        {variant === "v4" && (
                            <span
                                style={{
                                    marginLeft: "8px",
                                    padding: "2px 10px",
                                    borderRadius: "6px",
                                    border: "1px solid rgba(47,127,214,0.55)",
                                    background: "rgba(47,127,214,0.15)",
                                    fontSize: "16px",
                                    color: "#9ecbff",
                                    letterSpacing: "0.1em",
                                }}
                            >
                                V4
                            </span>
                        )}
                    </div>

                    {/* Middle */}
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "40px",
                            marginTop: "auto",
                            marginBottom: "auto",
                        }}
                    >
                        {image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={image}
                                alt={symbol}
                                width={220}
                                height={220}
                                style={{
                                    borderRadius: "28px",
                                    objectFit: "cover",
                                    border:
                                        "2px solid rgba(255,255,255,0.15)",
                                }}
                            />
                        ) : (
                            <div
                                style={{
                                    width: "220px",
                                    height: "220px",
                                    borderRadius: "28px",
                                    background:
                                        "linear-gradient(135deg, #2f7fd6, #15508f)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: "100px",
                                    fontWeight: 800,
                                    color: "white",
                                }}
                            >
                                {symbol.charAt(0)}
                            </div>
                        )}
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                maxWidth: "640px",
                            }}
                        >
                            <div
                                style={{
                                    fontSize: "30px",
                                    color: "#9ecbff",
                                    fontWeight: 600,
                                    letterSpacing: "0.05em",
                                }}
                            >
                                ${symbol}
                            </div>
                            <div
                                style={{
                                    fontSize: "64px",
                                    fontWeight: 700,
                                    lineHeight: 1.05,
                                    marginTop: "4px",
                                    wordBreak: "break-word",
                                }}
                            >
                                {name}
                            </div>
                            {creator && (
                                <div
                                    style={{
                                        fontSize: "22px",
                                        color: "rgba(255,255,255,0.6)",
                                        marginTop: "12px",
                                    }}
                                >
                                    by @{creator}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Footer */}
                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-end",
                        }}
                    >
                        {fdv ? (
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                }}
                            >
                                <span
                                    style={{
                                        fontSize: "18px",
                                        color: "rgba(255,255,255,0.55)",
                                        letterSpacing: "0.08em",
                                    }}
                                >
                                    MARKET CAP
                                </span>
                                <span
                                    style={{
                                        fontSize: "42px",
                                        fontWeight: 700,
                                        marginTop: "4px",
                                    }}
                                >
                                    ${fdv}
                                </span>
                            </div>
                        ) : (
                            <span />
                        )}
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                                padding: "14px 26px",
                                borderRadius: "14px",
                                background:
                                    "linear-gradient(135deg, #2f7fd6, #15508f)",
                                fontSize: "22px",
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
    } catch (err) {
        // Never let the OG route return blank. Fall back to a minimal
        // branded card so the share preview still works.
        // eslint-disable-next-line no-console
        console.error("[og] generation failed", err);
        return new ImageResponse(
            (
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        height: "100%",
                        background:
                            "linear-gradient(135deg, #001029 0%, #15508f 100%)",
                        color: "white",
                        fontSize: "72px",
                        fontWeight: 800,
                        fontFamily: "system-ui, sans-serif",
                        letterSpacing: "0.1em",
                    }}
                >
                    ARCADE
                </div>
            ),
            { width: 1200, height: 630 },
        );
    }
}
