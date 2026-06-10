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
 *
 * Null responses are NOT cached (transient outage shouldn't pin a wrong
 * answer for 5 minutes). `?debug=1` returns the per-RPC attempt log.
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
    value?: string | null;
}

async function reverse(address: `0x${string}`): Promise<{
    name: string | null;
    attempts: AttemptLog[];
}> {
    const attempts: AttemptLog[] = [];
    for (const { url, client } of clients) {
        try {
            const name = await client.getEnsName({ address });
            attempts.push({ url, ok: true, value: name ?? null });
            if (name) return { name, attempts };
        } catch (e) {
            attempts.push({
                url,
                ok: false,
                error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
            });
        }
    }
    return { name: null, attempts };
}

async function forward(name: string): Promise<{
    address: `0x${string}` | null;
    attempts: AttemptLog[];
}> {
    const attempts: AttemptLog[] = [];
    for (const { url, client } of clients) {
        try {
            const a = await client.getEnsAddress({ name });
            attempts.push({ url, ok: true, value: a ?? null });
            if (a && isAddress(a)) return { address: a as `0x${string}`, attempts };
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
    const addressParam = (url.searchParams.get("address") || "").trim();
    const debug = url.searchParams.get("debug") === "1";
    if (!isAddress(addressParam)) {
        return NextResponse.json({ name: null }, { status: 200 });
    }
    const addr = addressParam as `0x${string}`;
    const reverseResult = await reverse(addr);
    if (!reverseResult.name) {
        const body: Record<string, unknown> = { name: null };
        if (debug) body.reverseAttempts = reverseResult.attempts;
        return NextResponse.json(body, {
            status: 200,
            headers: { "cache-control": "no-store" },
        });
    }
    const forwardResult = await forward(reverseResult.name);
    const verified =
        forwardResult.address && forwardResult.address.toLowerCase() === addr.toLowerCase();
    const body: Record<string, unknown> = { name: verified ? reverseResult.name : null };
    if (debug) {
        body.reverseAttempts = reverseResult.attempts;
        body.forwardAttempts = forwardResult.attempts;
        body.candidateName = reverseResult.name;
        body.forwardResolved = forwardResult.address;
    }
    return NextResponse.json(body, {
        status: 200,
        headers: verified
            ? {
                  "cache-control": "public, s-maxage=300, stale-while-revalidate=86400",
              }
            : {
                  "cache-control": "no-store",
              },
    });
}
