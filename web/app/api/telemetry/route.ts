import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side telemetry sink (audit A-6). lib/telemetry.ts POSTs here
 * fire-and-forget; this route forwards a sampled subset to the
 * configured Sentry DSN (server-only env var, never NEXT_PUBLIC_*) so
 * the secret stays out of the client bundle.
 *
 * Why the indirection: shipping the Sentry SDK in the client bundle
 * adds ~30 kB gzipped and locks in a vendor. This stub keeps client
 * weight at ~0 kB (just a tiny fetch helper) while still streaming the
 * events that matter. Operators who later swap Sentry for PostHog /
 * Datadog only change THIS file.
 *
 * Sampling: error events ship 100%, info events ship 5% by default so
 * the free tier survives a usage spike. Adjust via SENTRY_INFO_SAMPLE_RATE
 * in env (default 0.05).
 */

const SENTRY_DSN = process.env.SENTRY_DSN;
const SAMPLE_RATE = Number(process.env.SENTRY_INFO_SAMPLE_RATE ?? "0.05");

function parseDsn(dsn: string) {
    try {
        const u = new URL(dsn);
        const projectId = u.pathname.replace(/^\//, "");
        return {
            host: u.host,
            projectId,
            publicKey: u.username,
            endpoint: `https://${u.host}/api/${projectId}/store/`,
        };
    } catch {
        return null;
    }
}

const parsed = SENTRY_DSN ? parseDsn(SENTRY_DSN) : null;

interface Body {
    level?: "info" | "warning" | "error";
    name?: string;
    data?: Record<string, unknown>;
}

export async function POST(req: NextRequest) {
    if (!parsed) return NextResponse.json({ ok: true });
    let body: Body;
    try {
        body = (await req.json()) as Body;
    } catch {
        return NextResponse.json({ ok: false }, { status: 400 });
    }
    const level = body.level ?? "info";
    if (level === "info" && Math.random() > SAMPLE_RATE) {
        return NextResponse.json({ ok: true, sampled: false });
    }
    // Minimal Sentry-compatible payload. The free-tier store endpoint
    // accepts this envelope. Real Sentry SDK adds breadcrumbs / context
    // we deliberately keep out for privacy.
    const payload = {
        timestamp: Math.floor(Date.now() / 1000),
        level,
        message: body.name,
        platform: "javascript",
        extra: body.data,
        release: process.env.NEXT_PUBLIC_GIT_SHA ?? "dev",
    };
    try {
        await fetch(parsed.endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=arcade/1`,
            },
            body: JSON.stringify(payload),
            // Don't block the response on Sentry's reply.
            cache: "no-store",
        });
    } catch {
        // Sentry down or rate-limited — degrade silently.
    }
    return NextResponse.json({ ok: true });
}
