import { NextRequest, NextResponse } from "next/server";

/**
 * Circle Stablecoin-Kit swap proxy.
 *
 * The App Kit swap path calls https://api.circle.com/v1/stablecoinKits/*
 * directly from the browser. That fails for two reasons:
 *   1. CORS — api.circle.com sends no Access-Control-Allow-Origin, so the
 *      browser blocks the response ("Failed to fetch").
 *   2. Auth — the endpoint requires a Bearer Kit Key (format
 *      `KIT_KEY:<id>:<secret>`), which we keep server-side.
 *
 * This same-origin route forwards the SDK's request to Circle, injecting
 * the Authorization header server-side. The client-side fetch interceptor
 * (lib/fx/appKit.ts) rewrites the SDK's api.circle.com calls to hit this
 * route. SSRF-guarded: only the stablecoinKits path is forwardable.
 */

export const dynamic = "force-dynamic";

const ALLOWED_PREFIX = "https://api.circle.com/v1/stablecoinKits";
// Server-side read of the (publishable) Kit Key. It must carry the
// `KIT_KEY:` environment prefix or Circle rejects it as malformed.
const KIT_KEY = process.env.NEXT_PUBLIC_CIRCLE_KIT_KEY;

async function forward(req: NextRequest): Promise<NextResponse> {
    const target = req.nextUrl.searchParams.get("target");
    if (!target || !target.startsWith(ALLOWED_PREFIX)) {
        return NextResponse.json(
            { error: "target must be a Circle stablecoinKits URL" },
            { status: 400 },
        );
    }
    if (!KIT_KEY) {
        return NextResponse.json(
            { error: "NEXT_PUBLIC_CIRCLE_KIT_KEY not configured" },
            { status: 500 },
        );
    }
    const method = req.method.toUpperCase();
    const body =
        method === "GET" || method === "HEAD" ? undefined : await req.text();
    try {
        const upstream = await fetch(target, {
            method,
            headers: {
                Authorization: `Bearer ${KIT_KEY}`,
                "Content-Type": "application/json",
            },
            body,
        });
        const text = await upstream.text();
        return new NextResponse(text, {
            status: upstream.status,
            headers: { "Content-Type": "application/json" },
        });
    } catch (err) {
        return NextResponse.json(
            {
                error: "proxy fetch failed",
                detail: err instanceof Error ? err.message : String(err),
            },
            { status: 502 },
        );
    }
}

export async function GET(req: NextRequest) {
    return forward(req);
}
export async function POST(req: NextRequest) {
    return forward(req);
}
