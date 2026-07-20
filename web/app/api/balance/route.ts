import { NextRequest, NextResponse } from "next/server";
import { erc20Abi, isAddress, type Address } from "viem";

import { ADDRESSES } from "@/lib/constants";
import { serverPublicClient } from "@/lib/serverRpc";

/**
 * Server-side USDC balance read. The header wallet widget's direct browser viem
 * client to the Arc RPC returns 0 (CORS / rate-limit on browser-origin eth_call,
 * even in incognito), while wallet-provider reads work. Reading server-side
 * bypasses the browser entirely -- same pattern as /api/ens/*. Returns the raw
 * 6-dp USDC balance as a string.
 */
export const dynamic = "force-dynamic";

// Fallback across RPC endpoints so a rate-limited primary falls over (serverRpc).
const client = serverPublicClient();

// Warm-instance cache: dedupe rapid polls for the same address (multiple tabs /
// re-renders) so each address hits the RPC at most once per TTL. Serverless
// memory is per-instance, so this only helps within a warm lifetime, but that is
// exactly where the burst polling happens.
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { raw: string; at: number }>();

export async function GET(req: NextRequest) {
    const address = req.nextUrl.searchParams.get("address");
    if (!address || !isAddress(address)) {
        return NextResponse.json({ error: "invalid address" }, { status: 400 });
    }
    const key = address.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return NextResponse.json({ raw: hit.raw }, { headers: { "Cache-Control": "no-store" } });
    }
    const usdc = ADDRESSES.usdc as Address | undefined;
    if (!usdc) return NextResponse.json({ error: "usdc address not configured" }, { status: 500 });
    try {
        const raw = (await client.readContract({
            address: usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address as Address],
        })) as bigint;
        cache.set(key, { raw: raw.toString(), at: Date.now() });
        return NextResponse.json(
            { raw: raw.toString() },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (e) {
        // On a rate-limit blip, serve the last known value rather than 502.
        if (hit) return NextResponse.json({ raw: hit.raw }, { headers: { "Cache-Control": "no-store" } });
        return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
}
