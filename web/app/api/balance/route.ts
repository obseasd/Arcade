import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, erc20Abi, isAddress, type Address } from "viem";

import { ADDRESSES } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";

/**
 * Server-side USDC balance read. The header wallet widget's direct browser viem
 * client to the Arc RPC returns 0 (CORS / rate-limit on browser-origin eth_call,
 * even in incognito), while wallet-provider reads work. Reading server-side
 * bypasses the browser entirely -- same pattern as /api/ens/*. Returns the raw
 * 6-dp USDC balance as a string.
 */
export const dynamic = "force-dynamic";

const client = createPublicClient({ chain: arcTestnet, transport: http() });

export async function GET(req: NextRequest) {
    const address = req.nextUrl.searchParams.get("address");
    if (!address || !isAddress(address)) {
        return NextResponse.json({ error: "invalid address" }, { status: 400 });
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
        return NextResponse.json(
            { raw: raw.toString() },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
}
