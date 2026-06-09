import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

/**
 * Server-side ENS forward resolution. Browser-side calls to public ETH
 * RPCs (llamarpc, publicnode, cloudflare-eth, etc) are routinely blocked
 * by ad-blockers (uBlock, Brave Shields, AdGuard) because those endpoints
 * are on the EasyPrivacy + EasyList web3 filter lists. Routing through a
 * same-origin Next.js API hop bypasses all client-side blockers, since
 * the browser sees /api/ens/forward as our own domain.
 *
 * Multi-RPC fallback: if one provider rate-limits or 5xx's, try the next.
 * ENS reads are pure-view contract calls — any working L1 RPC returns the
 * same answer, so the fallback list is safe to walk indiscriminately.
 *
 * Cached at the edge for 5 minutes per name to keep the RPC budget low
 * when many users resolve the same vanity names (vitalik.eth, etc.).
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

async function resolveForward(name: string) {
    for (const client of clients) {
        try {
            const addr = await client.getEnsAddress({ name });
            if (addr && isAddress(addr)) {
                return { address: addr };
            }
        } catch {
            // try the next RPC
        }
    }
    return { address: null };
}

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const raw = (url.searchParams.get("name") || "").trim();
    if (!raw || !raw.includes(".")) {
        return NextResponse.json({ address: null }, { status: 200 });
    }
    let normalized: string;
    try {
        normalized = normalize(raw);
    } catch {
        return NextResponse.json({ address: null }, { status: 200 });
    }
    const result = await resolveForward(normalized);
    return NextResponse.json(result, {
        status: 200,
        headers: {
            "cache-control": "public, s-maxage=300, stale-while-revalidate=86400",
        },
    });
}
