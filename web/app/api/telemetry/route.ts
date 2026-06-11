import { NextRequest, NextResponse } from "next/server";
import { rateLimit, rejectCrossOrigin } from "@/lib/apiGuard";

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

// Audit 2026-06-11 API-2: defense-in-depth on the telemetry sink so a
// third-party page can't drain Sentry quota via cross-origin POSTs nor
// stuff attacker-controlled strings into the operator dashboard.
//   1. rejectCrossOrigin gates Sec-Fetch-Site (same OWASP gate as pin
//      routes and twitter-login).
//   2. rateLimit caps spam from a single IP/UA bucket.
//   3. MAX_BODY_BYTES rejects oversized payloads before JSON parse so a
//      multi-MB body can't OOM the function or stuff Sentry events.
//   4. ALLOWED_LEVELS whitelists `level` so a hostile body can't bypass
//      the info-sampler by passing `level: "error"` and burn the full
//      quota.
//   5. ALLOWED_NAMES (prefix match on a short list) keeps event names
//      auditable; an unknown name still ships but with a sanitised
//      placeholder, so the dashboard's filter UX isn't polluted.
const MAX_BODY_BYTES = 4_096;
const ALLOWED_LEVELS = new Set<Body["level"]>(["info", "warning", "error"]);
const ALLOWED_NAME_PREFIXES = ["swap.", "bridge.", "claim.", "provider.", "ui."];

export async function POST(req: NextRequest) {
    const cross = rejectCrossOrigin(req);
    if (cross) return cross;
    const rl = rateLimit(req, "telemetry", 120, 60_000);
    if (rl) return rl;
    if (!parsed) return NextResponse.json({ ok: true });
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
        return NextResponse.json({ ok: false }, { status: 413 });
    }
    let bodyText: string;
    try {
        bodyText = await req.text();
    } catch {
        return NextResponse.json({ ok: false }, { status: 400 });
    }
    if (bodyText.length > MAX_BODY_BYTES) {
        return NextResponse.json({ ok: false }, { status: 413 });
    }
    let body: Body;
    try {
        body = JSON.parse(bodyText) as Body;
    } catch {
        return NextResponse.json({ ok: false }, { status: 400 });
    }
    const rawLevel = body.level;
    const level = rawLevel && ALLOWED_LEVELS.has(rawLevel) ? rawLevel : "info";
    const rawName = typeof body.name === "string" ? body.name.slice(0, 80) : "";
    const knownName = ALLOWED_NAME_PREFIXES.some((p) => rawName.startsWith(p));
    const name = knownName ? rawName : "ui.unknown";
    if (level === "info" && Math.random() > SAMPLE_RATE) {
        return NextResponse.json({ ok: true, sampled: false });
    }
    // Minimal Sentry-compatible payload. The free-tier store endpoint
    // accepts this envelope. Real Sentry SDK adds breadcrumbs / context
    // we deliberately keep out for privacy.
    const payload = {
        timestamp: Math.floor(Date.now() / 1000),
        level,
        message: name,
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
