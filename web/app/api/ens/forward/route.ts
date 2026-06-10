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
 * Only positive responses (address resolved) get edge-cached for 5 minutes;
 * null responses are NOT cached so a transient RPC outage doesn't poison
 * the cache for the next 5 minutes.
 *
 * Debug mode: append `?debug=1` to the URL to see which RPCs were tried
 * and what each returned (errors + raw addresses). Useful when null gets
 * returned and we don't know which provider is misbehaving.
 */
const RPCS = [
    process.env.MAINNET_RPC,
    process.env.NEXT_PUBLIC_MAINNET_RPC,
    "https://eth.llamarpc.com",
    "https://ethereum-rpc.publicnode.com",
    "https://rpc.flashbots.net",
    "https://eth-mainnet.public.blastapi.io",
    "https://eth.merkle.io",
    "https://endpoints.omniatech.io/v1/eth/mainnet/public",
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
].filter((u): u is string => {
    if (!u) return false;
    try {
        return new URL(u).protocol === "https:";
    } catch {
        return false;
    }
});

// retryCount: 0 so a single failing RPC doesn't eat the 10s function budget.
// timeout: 5s per provider, so 10 providers fit in ~50s worst case but in
// practice the FIRST working provider returns within ~500ms.
const clients = RPCS.map((url) => ({
    url,
    client: createPublicClient({
        chain: mainnet,
        transport: http(url, { retryCount: 0, timeout: 5_000 }),
    }),
}));

interface AttemptLog {
    url: string;
    ok: boolean;
    error?: string;
    address?: string | null;
}

async function resolveForward(name: string): Promise<{
    address: `0x${string}` | null;
    attempts: AttemptLog[];
}> {
    const attempts: AttemptLog[] = [];
    for (const { url, client } of clients) {
        try {
            const addr = await client.getEnsAddress({ name });
            attempts.push({ url, ok: true, address: addr ?? null });
            if (addr && isAddress(addr)) {
                return { address: addr, attempts };
            }
        } catch (e) {
            attempts.push({
                url,
                ok: false,
                error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
            });
        }
    }
    return { address: null, attempts };
}

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const raw = (url.searchParams.get("name") || "").trim();
    const debug = url.searchParams.get("debug") === "1";
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
    const body: Record<string, unknown> = { address: result.address };
    if (debug) {
        body.attempts = result.attempts;
        body.normalized = normalized;
    }
    return NextResponse.json(body, {
        status: 200,
        headers: result.address
            ? {
                  "cache-control": "public, s-maxage=300, stale-while-revalidate=86400",
              }
            : {
                  // Do not cache null responses: a transient outage would
                  // otherwise pin "not found" for 5 minutes for every user.
                  "cache-control": "no-store",
              },
    });
}
