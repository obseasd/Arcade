import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress, keccak256, stringToBytes, concat, type Hex, parseAbi } from "viem";
import { mainnet } from "viem/chains";

/**
 * Server-side ENS forward resolution.
 *
 * Manual stack from the ground up because the high-level helpers
 * (`viem/ens`'s `normalize` and `namehash`) silently bundled to undefined
 * in this Next.js 15 serverless runtime, which produced `namehash(undefined)`
 * = root node, every Registry.resolver() call returned address(0), and
 * resolution failed for every name. Confirmed by debug payload showing
 * `normalized: undefined, node: 0x000...000`.
 *
 * Replacements:
 *  - normalize(): trim + toLowerCase. Skips full UTS-46 (Unicode
 *    homoglyph + IDN normalization for `.eth` names containing emojis /
 *    non-ASCII characters), which is fine for the Send recipient flow
 *    where users type ASCII names. If a user types `Vitalik.ETH` it
 *    still resolves via the toLowerCase.
 *  - namehash(): standard ENS namehash recursion using viem's keccak256
 *    + stringToBytes + concat (all of which DO bundle correctly).
 *
 * Resolution path stays Registry -> Resolver.addr (no Universal Resolver,
 * no CCIP-Read), edge-cached on positive responses, no-store on null.
 * `?debug=1` returns per-RPC attempt log + computed node.
 */

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;

const REGISTRY_ABI = parseAbi([
    "function resolver(bytes32 node) view returns (address)",
]);

const RESOLVER_ABI = parseAbi([
    "function addr(bytes32 node) view returns (address)",
]);

// Audit F-6: shortlist trimmed from 9 to 4 RPCs. Walking through 9
// providers leaked the IP + (more importantly) the queried address —
// which equals the recipient of every transfer the user is about to
// make — to 9 third-party operators. The remaining 4 are the most
// reliable + lowest-log providers, and they are tried in the order
// (paid env → llamarpc → cloudflare-eth → publicnode). For an
// operator who wants stronger privacy, set MAINNET_RPC to an Alchemy /
// Infura key and the public list is never consulted.
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

function basicNormalize(raw: string): string {
    return raw.trim().toLowerCase();
}

// Standard ENS namehash. EIP-137.
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

interface AttemptLog {
    url: string;
    ok: boolean;
    error?: string;
    resolver?: string;
    address?: string | null;
}

interface ResolveResult {
    address: `0x${string}` | null;
    attempts: AttemptLog[];
    node: Hex;
}

async function resolveForward(name: string): Promise<ResolveResult> {
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
    const normalized = basicNormalize(raw);
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
