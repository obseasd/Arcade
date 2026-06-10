import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress, keccak256, stringToBytes, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { namehash } from "viem/ens";

/**
 * Server-side ENS reverse resolution + forward-verify roundtrip.
 *
 * Manual ENS Registry + Resolver flow (no Universal Resolver / CCIP-Read)
 * so we dodge viem 2.50's getEnsAddress crash in serverless. Reverse:
 *   1. node = namehash(<addrLower>.addr.reverse)
 *   2. resolver = ENSRegistry.resolver(node)
 *   3. name = Resolver.name(node)
 * Then forward-resolve `name` back through the same Registry → Resolver
 * → addr flow and only return `name` if it round-trips back to the same
 * address (anti-impersonation: an attacker can set their primary name to
 * "vitalik.eth" but can't make the forward resolver return their address).
 *
 * Null responses are NOT cached. `?debug=1` returns the per-RPC attempt log.
 */

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;

const REGISTRY_ABI = parseAbi([
    "function resolver(bytes32 node) view returns (address)",
]);

const RESOLVER_ABI = parseAbi([
    "function addr(bytes32 node) view returns (address)",
    "function name(bytes32 node) view returns (string)",
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

// reverseNode computes namehash("<addr-lower-no-0x>.addr.reverse"). This
// matches the convention used by ENS's reverse registrar so resolver.name
// returns the primary name. We compute it manually using viem's namehash
// instead of the helper viem doesn't export for this path.
function reverseNode(address: `0x${string}`): `0x${string}` {
    const lower = address.toLowerCase().slice(2);
    // ENS reverse namehash: hash("addr.reverse") + hash(addrLowerNo0x)
    // viem's namehash does this when given "<lower>.addr.reverse".
    return namehash(`${lower}.addr.reverse`);
}

// keccak256 is imported just so the bundler keeps it; viem's namehash uses
// it internally. stringToBytes too. (Both required by named import shape.)
void keccak256;
void stringToBytes;

interface AttemptLog {
    url: string;
    ok: boolean;
    error?: string;
    resolver?: string;
    value?: string | null;
}

async function reverse(address: `0x${string}`): Promise<{
    name: string | null;
    attempts: AttemptLog[];
}> {
    const attempts: AttemptLog[] = [];
    const node = reverseNode(address);
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
            const name = await client.readContract({
                address: resolver,
                abi: RESOLVER_ABI,
                functionName: "name",
                args: [node],
            });
            attempts.push({ url, ok: true, resolver, value: name ?? null });
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
            const a = await client.readContract({
                address: resolver,
                abi: RESOLVER_ABI,
                functionName: "addr",
                args: [node],
            });
            attempts.push({ url, ok: true, resolver, value: a ?? null });
            if (a && isAddress(a) && a !== ZERO) return { address: a, attempts };
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
