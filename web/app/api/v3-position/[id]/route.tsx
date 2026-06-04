import { NextRequest, NextResponse } from "next/server";

/**
 * ERC-721 metadata endpoint for ArcadeV3PositionManager. The on-chain
 * tokenURI() returns https://www.arcade.trading/api/v3-position/<tokenId>,
 * which this route resolves to a JSON document compatible with wallets,
 * marketplaces, and indexers.
 *
 * Image is a static brand glyph for now (Arcade machine on navy). Once the
 * ArcLens indexer is live we can swap to a per-position SVG that renders
 * the pair symbols, fee tier, tick range and current PnL — same shape as
 * Uniswap's NFT-descriptor SVG output, but with the Arcade palette.
 */
export const runtime = "edge";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const tokenId = id.replace(/[^0-9]/g, "") || "0";

    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const image = `${origin}/arcade.png`;

    const metadata = {
        name: `Arcade V3 Position #${tokenId}`,
        description:
            "Concentrated-liquidity position minted on Arcade, the USDC-native AMM on Arc. " +
            "View, manage, and unwind at https://www.arcade.trading/positions.",
        image,
        external_url: `https://www.arcade.trading/positions`,
        attributes: [
            { trait_type: "Token ID", value: tokenId },
            { trait_type: "Chain", value: "Arc Testnet" },
            { trait_type: "Protocol", value: "Arcade V3" },
        ],
    };

    return NextResponse.json(metadata, {
        headers: {
            "Cache-Control": "public, max-age=60, s-maxage=300",
        },
    });
}
