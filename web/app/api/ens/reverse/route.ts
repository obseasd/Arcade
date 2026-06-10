import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress, keccak256, stringToBytes, concat, type Hex, parseAbi } from "viem";
import { mainnet } from "viem/chains";

/**
 * Server-side ENS reverse resolution + forward-verify roundtrip. Manual
 * Registry + Resolver lookup like the forward route, because viem/ens's
 * `normalize` + `namehash` silently bundle to undefined in serverless,
 * which made every lookup target the ENS root node and return address(0).
 *
 * Reverse path: namehash("<addrLower-no-0x>.addr.reverse") -> Registry
 * -> Resolver.name -> forward-verify the returned name back through the
 * same Registry -> Resolver.addr to defend against impersonation.
 *
 * No CCIP-Read (which is what we need for cross-chain reverse), but
 * standard *.eth reverse records (the common case for our Send modal)
 * still work. Null responses are NOT cached.
 */

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;

const REGISTRY_ABI = parseAbi([
    "function resolver(bytes32 node) view returns (address)",
]);

const RESOLVER_ABI = parseAbi([
    "function addr(bytes32 node) view returns (address)",
    "function name(bytes32 node) view returns (string)",
]);

// Audit F-6: shortlist trimmed — see /api/ens/forward for rationale.
const RPCS = [
    process.env.MAINNET_RPC,
    process.env.NEXT_PUBLIC_MAINNET_RPC,
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://ethereum-rpc.publicnode.com",
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
const EMPTY_NODE = ("0x" + "00".repeat(32)) as Hex;

function manualNamehash(name: string): Hex {
    if (!name) return EMPTY_NODE;
    let node: Hex = EMPTY_NODE;
    const labels = name.split(".");
    for (let i = labels.length - 1; i >= 0; i--) {
        const label = labels[i];
        if (!label) continue;
        const labelHash = keccak256(stringToBytes(label));
        node = keccak256(concat([node, labelHash]));
    }
    return node;
}

function reverseNode(address: `0x${string}`): Hex {
    const lower = address.toLowerCase().slice(2);
    return manualNamehash(`${lower}.addr.reverse`);
}

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
                error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
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
    const node = manualNamehash(name);
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
                error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
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
