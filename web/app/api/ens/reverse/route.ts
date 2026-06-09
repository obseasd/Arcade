import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import { mainnet } from "viem/chains";

/**
 * Server-side ENS reverse resolution + forward-verify roundtrip.
 *
 * Returns the primary name only when it forward-resolves back to the
 * original address (anti-impersonation: an attacker can set their primary
 * name to "vitalik.eth", but they can't make that name's forward resolver
 * point at their address). Same multi-RPC fallback + cache as
 * /api/ens/forward. Lives server-side to dodge ad-blocker filter lists.
 */
const RPCS = [
    process.env.MAINNET_RPC,
    process.env.NEXT_PUBLIC_MAINNET_RPC,
    "https://eth.llamarpc.com",
    "https://ethereum-rpc.publicnode.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
].filter((u): u is string => {
    if (!u) return false;
    try {
        return new URL(u).protocol === "https:";
    } catch {
        return false;
    }
});

const clients = RPCS.map((url) =>
    createPublicClient({ chain: mainnet, transport: http(url) }),
);

async function reverse(address: `0x${string}`) {
    for (const client of clients) {
        try {
            const name = await client.getEnsName({ address });
            if (name) return name;
        } catch {
            // try next
        }
    }
    return null;
}

async function forward(name: string) {
    for (const client of clients) {
        try {
            const a = await client.getEnsAddress({ name });
            if (a && isAddress(a)) return a as `0x${string}`;
        } catch {
            // try next
        }
    }
    return null;
}

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const addressParam = (url.searchParams.get("address") || "").trim();
    if (!isAddress(addressParam)) {
        return NextResponse.json({ name: null }, { status: 200 });
    }
    const addr = addressParam as `0x${string}`;
    const name = await reverse(addr);
    if (!name) {
        return NextResponse.json(
            { name: null },
            {
                status: 200,
                headers: {
                    "cache-control": "public, s-maxage=300, stale-while-revalidate=86400",
                },
            },
        );
    }
    const back = await forward(name);
    const verified = back && back.toLowerCase() === addr.toLowerCase();
    return NextResponse.json(
        { name: verified ? name : null },
        {
            status: 200,
            headers: {
                "cache-control": "public, s-maxage=300, stale-while-revalidate=86400",
            },
        },
    );
}
