import { NextRequest, NextResponse } from "next/server";

/**
 * Shared API-route guard helpers used by /api/pin/* and any other endpoint
 * that takes resources we pay for (Pinata pins, Pinata bandwidth, etc.).
 *
 * Audit FSEC-003 walked the exploit: the pin endpoints used to accept
 * cross-origin POSTs with multipart form-data (a CORS "simple" content
 * type) and authenticated to Pinata using the server-side PINATA_JWT. An
 * attacker dropping a hidden auto-submitting form on any third-party
 * page could burn through our pin quota within minutes. We add the same
 * `Sec-Fetch-Site` check the twitter-login route uses (which OWASP also
 * recommends as the modern same-origin gate) plus a tiny in-memory
 * per-IP rate limit.
 *
 * The in-memory counters are per-Vercel-instance and reset on cold
 * start - good enough to defend against a sustained CSRF burst, not
 * a sophisticated distributed attacker (for that we'd need Redis /
 * Upstash). For mainnet keep an eye on the Pinata billing dashboard
 * and tighten the per-window count if we see organic traffic exceed
 * the cap.
 */

/** Same Sec-Fetch-Site gate as twitter-login. Returns a 403 NextResponse
 *  on cross-origin requests (img / iframe / cross-site form), null on
 *  legit same-origin requests, typed URL navigations, or browsers that
 *  don't send the header (fail open for legacy compat). */
export function rejectCrossOrigin(req: NextRequest): NextResponse | null {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return NextResponse.json(
      { error: "Cross-origin request not allowed" },
      { status: 403 },
    );
  }
  return null;
}

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/** Token-bucket-ish per-IP rate limit. `maxPerWindow` requests per
 *  `windowMs` window. Returns a 429 NextResponse when the limit is
 *  exceeded, null when the request is allowed. */
export function rateLimit(
  req: NextRequest,
  key: string,
  maxPerWindow: number,
  windowMs: number,
): NextResponse | null {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const bucket = buckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(bucketKey, { count: 1, windowStart: now });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > maxPerWindow) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(windowMs / 1000)) } },
    );
  }
  return null;
}
