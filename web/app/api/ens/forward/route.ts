import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { normalize, namehash } from "viem/ens";

/**
 * Server-side ENS forward resolution. Browser-side calls to public ETH
 * RPCs (llamarpc, publicnode, cloudflare-eth, etc) are routinely blocked
 * by ad-blockers (uBlock, Brave Shields, AdGuard) because those endpoints
 * are on the EasyPrivacy + EasyList web3 filter lists. Routing through a
 * same-origin Next.js API hop bypasses all client-side blockers.
 *
 * Why manual ENS Registry + Resolver instead of viem's getEnsAddress:
 * viem 2.50 routes through the NEW universal resolver
 * (0xeeeeeeee14d718c2b47d9923deab1335e144eeee) which calls
 * resolveWithGateways(...) and depends on viem's CCIP-Read offchain
 * gateway batch handler. That handler crashes in the Vercel serverless
 * runtime with "Cannot read properties of undefined (reading 'replace')"
 * for every RPC we tried (confirmed against 8 different providers).
 *
 * Going manual through ENS Registry → Resolver → addr() skips the
 * universal resolver + CCIP-Read entirely. It does not resolve cross-
 * chain ENS names (CCIP-Read is needed for those) but it does resolve
 * every standard *.eth name including vitalik.eth, which is what users
 * type in our send field. Edge cache stays on positive responses.
 *
 * `?debug=1` returns per-RPC attempt log.
 */

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;

const REGISTRY_ABI = parseAbi([
    "function resolver(bytes32 node) view returns (address)",
]);

const RESOLVER_ABI = parseAbi([
    "function addr(bytes32 node) view returns (address)",
]);

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

const ZERO = "0x0000000000000000000000000000000000000000";

interface AttemptLog {
    url: string;
    ok: boolean;
    error?: string;
    resolver?: string;
    address?: string | null;
}

async function resolveForward(name: string): Promise<{
    address: `0x${string}` | null;
    attempts: AttemptLog[];
    node: string;
}> {
    const attempts: AttemptLog[] = [];
    const node = namehash(name);
    for (const { url, client } of clients) {
        try {
            const resolver = await client.readContract({
                address: ENS_REGISTRY,
                abi: REGISTRY_ABI,
                functionName: "resolver",
                args: [node],
            });
            if (!resolver || resolver === ZERO) {
                attempts.push({ url, ok: true, resolver: ZERO });
                continue;
            }
            const addr = await client.readContract({
                address: resolver,
                abi: RESOLVER_ABI,
                functionName: "addr",
                args: [node],
            });
            attempts.push({ url, ok: true, resolver, address: addr ?? null });
            if (addr && isAddress(addr) && addr !== ZERO) {
                return { address: addr, attempts, node };
            }
        } catch (e) {
            attempts.push({
                url,
                ok: false,
                error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
            });
        }
    }
    return { address: null, attempts, node };
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
        body.node = result.node;
        body.registry = ENS_REGISTRY;
    }
    return NextResponse.json(body, {
        status: 200,
        headers: result.address
            ? {
                  "cache-control": "public, s-maxage=300, stale-while-revalidate=86400",
              }
            : {
                  "cache-control": "no-store",
              },
    });
}
