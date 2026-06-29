import { NextResponse } from "next/server";

/** Agent endpoints are meant to be called by non-browser agents from any
 *  origin, so they are open + CORS-enabled (they only read or BUILD unsigned
 *  transactions; the agent signs with its own wallet, nothing is custodial). */
export const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

export const ok = (data: unknown) => NextResponse.json(data, { headers: CORS });

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
