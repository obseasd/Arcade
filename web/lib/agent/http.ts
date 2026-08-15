import { NextResponse, type NextRequest } from "next/server";
import { rateLimit } from "@/lib/apiGuard";

/** Agent endpoints are meant to be called by non-browser agents from any
 *  origin, so they are open + CORS-enabled (they only read or BUILD unsigned
 *  transactions; the agent signs with its own wallet, nothing is custodial). */
export const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

/** JSON 200 with CORS. `cacheSeconds > 0` adds a CDN Cache-Control so the
 *  Vercel edge serves repeat hits of a read-only endpoint WITHOUT re-invoking
 *  the function (a bot spamming a cacheable route then costs ~nothing). Only use
 *  it for non-user-specific reads (markets, trending) — never a per-wallet or
 *  amount-specific response. */
export const ok = (data: unknown, cacheSeconds = 0) =>
    NextResponse.json(data, {
        headers: cacheSeconds > 0
            ? { ...CORS, "Cache-Control": `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}` }
            : CORS,
    });

/** Generous per-IP rate limit for the PUBLIC agent surface (best-effort, in-memory
 *  per instance). Returns a CORS'd 429 when exceeded, null when allowed. High
 *  enough for real agent use; only trips egregious bot spam. */
export function agentLimit(
    req: NextRequest,
    key: string,
    maxPerWindow = 120,
    windowMs = 60_000,
): NextResponse | null {
    const rl = rateLimit(req, `agent-${key}`, maxPerWindow, windowMs);
    if (!rl) return null;
    // Re-wrap with CORS so a rate-limited agent still gets a readable response.
    return NextResponse.json(
        { ok: false, error: "rate limited, slow down", code: "RATE_LIMITED", retryable: true },
        { status: 429, headers: { ...CORS, "Retry-After": String(Math.ceil(windowMs / 1000)) } },
    );
}

/** Structured error so agents can branch: { ok:false, error, code, retryable }.
 *  Second arg accepts a status number (back-compat) or an options object. */
export const bad = (
    error: string,
    statusOrOpts: number | { status?: number; code?: string; retryable?: boolean } = 400,
) => {
    const o = typeof statusOrOpts === "number" ? { status: statusOrOpts } : statusOrOpts;
    return NextResponse.json(
        { ok: false, error, code: o.code ?? "BAD_REQUEST", retryable: o.retryable ?? false },
        { status: o.status ?? 400, headers: CORS },
    );
};
export const preflight = () => new NextResponse(null, { headers: CORS });

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const addr = (v: unknown): `0x${string}` | null =>
    typeof v === "string" && ADDR.test(v) ? (v as `0x${string}`) : null;
export const big = (v: unknown): bigint | null => {
    try {
        if (v === undefined || v === null) return null;
        const b = BigInt(String(v));
        return b >= 0n ? b : null;
    } catch {
        return null;
    }
};
