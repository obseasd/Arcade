import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

// Brand splash served as the global og:image for every page that doesn't
// override it (home, /swap, /launchpad, etc). Token-detail pages keep
// using ../route.tsx which embeds the token image + FDV.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const BG_FROM = "#001029";
const BG_MID = "#0A1F3A";
const BG_TO = "#15324F";
const CTA_HOVER = "#345A78";
const CTA = "#2f7fd6";

/**
 * Fetch a Google Font's binary payload so Satori can render the wordmark
 * in our brand typeface (Space Grotesk). Restricted to the glyphs we
 * actually draw so the payload stays under the edge memory limit.
 */
async function loadGoogleFont(
    family: string,
    weight: number,
    text: string,
): Promise<ArrayBuffer | null> {
    const url = `https://fonts.googleapis.com/css2?family=${family.replace(
        /\s+/g,
        "+",
    )}:wght@${weight}&text=${encodeURIComponent(text)}`;
    try {
        const css = await (await fetch(url)).text();
        const match = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/);
        if (!match) return null;
        const fontResp = await fetch(match[1]);
        if (!fontResp.ok) return null;
        return await fontResp.arrayBuffer();
    } catch {
        return null;
    }
}

function originFromReq(req: NextRequest): string {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
}

export async function GET(req: NextRequest) {
    const origin = originFromReq(req);
    const logo = `${origin}/arcade.png`;

    // Pull Space Grotesk for the wordmark; fall back to the embedded default
    // sans if Google blocks the edge fetch. The two font fetches are
    // independent (different family/weight/subset) so we kick them off in
    // parallel to halve the cold-cache latency on first OG render.
    const [headingFont, subFont] = await Promise.all([
        loadGoogleFont("Space Grotesk", 700, "Arcade"),
        loadGoogleFont("Inter", 500, "USDC-native AMM on Arc"),
    ]);

    return new ImageResponse(
        (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "100%",
                    height: "100%",
                    background: `linear-gradient(135deg, ${BG_FROM} 0%, ${BG_MID} 55%, ${BG_TO} 100%)`,
                    color: "#E5EEF8",
                    position: "relative",
                }}
            >
                {/* Two soft blue blooms in opposite corners so the canvas
                    reads as "depth + glow" rather than a flat navy field. */}
                <div
                    style={{
                        display: "flex",
                        position: "absolute",
                        top: -160,
                        left: -160,
                        width: 600,
                        height: 600,
                        borderRadius: 600,
                        background: CTA_HOVER,
                        opacity: 0.35,
                        filter: "blur(120px)",
                    }}
                />
                <div
                    style={{
                        display: "flex",
                        position: "absolute",
                        bottom: -180,
                        right: -160,
                        width: 600,
                        height: 600,
                        borderRadius: 600,
                        background: CTA,
                        opacity: 0.32,
                        filter: "blur(120px)",
                    }}
                />

                {/* Centre stack: logo + wordmark + tagline */}
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        zIndex: 10,
                    }}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={logo}
                        alt=""
                        width={300}
                        height={300}
                        style={{
                            width: 300,
                            height: 300,
                            objectFit: "contain",
                            filter: "drop-shadow(0 30px 70px rgba(47,127,214,0.45))",
                        }}
                    />
                    <div
                        style={{
                            display: "flex",
                            fontSize: 120,
                            fontWeight: 700,
                            fontFamily: headingFont ? "Space Grotesk" : "sans-serif",
                            letterSpacing: -2,
                            marginTop: 18,
                            color: "#E5EEF8",
                        }}
                    >
                        Arcade
                    </div>
                    <div
                        style={{
                            display: "flex",
                            fontSize: 28,
                            fontWeight: 500,
                            fontFamily: subFont ? "Inter" : "sans-serif",
                            color: "rgba(229,238,248,0.65)",
                            marginTop: 8,
                            letterSpacing: 0.5,
                        }}
                    >
                        USDC-native AMM on Arc
                    </div>
                </div>
            </div>
        ),
        {
            width: 1200,
            height: 630,
            fonts: [
                ...(headingFont
                    ? [
                          {
                              name: "Space Grotesk",
                              data: headingFont,
                              style: "normal" as const,
                              weight: 700 as const,
                          },
                      ]
                    : []),
                ...(subFont
                    ? [
                          {
                              name: "Inter",
                              data: subFont,
                              style: "normal" as const,
                              weight: 500 as const,
                          },
                      ]
                    : []),
            ],
        },
    );
}
