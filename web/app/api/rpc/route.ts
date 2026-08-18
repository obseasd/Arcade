import { NextRequest, NextResponse } from "next/server";

import { READ_RPC_URLS } from "@/lib/serverRpc";

/**
 * Same-origin JSON-RPC proxy for the BROWSER.
 *
 * WHY: the fastest Arc read RPC, drpc.org, sends NO `Access-Control-Allow-Origin`
 * header, so a browser fetch to it is blocked by CORS (the launchpad list,
 * balances, every wagmi read failed with a CORS error, and the app retried in a
 * loop -> "tokens won't load"). The 2026-08-14 RPC benchmark tested from a SERVER,
 * so it never saw the browser CORS wall.
 *
 * The browser's wagmi transport now hits THIS route (same-origin, always CORS-ok)
 * and the server relays the JSON-RPC body to the first healthy Arc read RPC with
 * its OWN IP -- no CORS, and drpc's per-IP rate-limit is shared server-side
 * instead of hammered per-user. Reads only: wallet transactions go through the
 * injected provider, and Arc's Multicall3 collapses `useReadContracts` fan-outs
 * into a single eth_call, so no request batching is needed here.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 512_000; // generous ceiling for a single eth_call / multicall

export async function POST(req: NextRequest) {
    let body: string;
    try {
        body = await req.text();
    } catch {
        return NextResponse.json({ error: "bad body" }, { status: 400 });
    }
    if (!body || body.length > MAX_BODY) {
        return NextResponse.json({ error: "empty or oversized body" }, { status: 400 });
    }

    let lastErr = "no endpoints";
    for (const url of READ_RPC_URLS) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) {
                lastErr = `${url} -> HTTP ${res.status}`;
                continue; // 429 / 5xx: try the next endpoint
            }
            const text = await res.text();
            // A JSON-RPC error is a valid 200 response the client handles; only a
            // transport failure (non-2xx / throw) falls through to the next RPC.
            return new NextResponse(text, {
                status: 200,
                headers: { "content-type": "application/json", "cache-control": "no-store" },
            });
        } catch (e) {
            lastErr = `${url} -> ${e instanceof Error ? e.message : String(e)}`;
        }
    }
    return NextResponse.json({ error: `all Arc RPC endpoints failed: ${lastErr}` }, { status: 502 });
}
