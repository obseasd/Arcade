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
/** Hard cap on the in-memory map. Once reached we prune buckets older than
 *  `windowMs` lazily on the next write. Without this the map grows
 *  unbounded under a sustained spoofed-IP attack and exhausts the Vercel
 *  function memory. */
const BUCKET_HARD_CAP = 5000;

/** Derive the client IP. On Vercel we prefer `x-vercel-forwarded-for`
 *  which is set by the edge and cannot be spoofed by the client (the
 *  edge strips any client-supplied value before injecting its own).
 *  `x-real-ip` is the next-best on Vercel; raw `x-forwarded-for` is
 *  trusted last because clients can prepend arbitrary values to its
 *  comma list and the leftmost entry is the client-controlled one. */
function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    // Fallback to x-forwarded-for ONLY for local/dev environments where the
    // platform headers aren't present. In production this last fallback is
    // moot because Vercel always sets x-vercel-forwarded-for.
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}

/** Token-bucket-ish per-IP rate limit. `maxPerWindow` requests per
 *  `windowMs` window. Returns a 429 NextResponse when the limit is
 *  exceeded, null when the request is allowed. */
export function rateLimit(
  req: NextRequest,
  key: string,
  maxPerWindow: number,
  windowMs: number,
): NextResponse | null {
  const ip = clientIp(req);
  // Audit 2026-06-11 v2 V2-F-03 fix: drop the User-Agent hash from the
  // bucket key. The morning's "shared-NAT collision" rationale held for
  // benign user collisions but the agent-controlled UA also let any
  // attacker multiply their per-IP budget by simply rotating
  // `User-Agent` between requests. We accept the false-positive rate on
  // CGNAT users (rare on a Web3 dApp where each user usually has their
  // own residential IP) in exchange for closing the bypass.
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  // Lazy prune when the map grows large. Walking the map is O(n) but only
  // fires on cap-hit, not per-request, so amortised cost is fine.
  if (buckets.size >= BUCKET_HARD_CAP) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart > windowMs) buckets.delete(k);
    }
  }
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

/**
 * Audit F-5: per-key rate limit that ignores client IP/UA. Use for caps
 * that must hold regardless of who calls — e.g. "no more than N OAuth
 * callbacks for a single (token, slotIndex) per minute", which prevents
 * a residential-proxy botnet from farming signatures by spreading IPs.
 *
 * The key SHOULD be derived from request payload (state cookie, slot id,
 * etc.), never from req.headers, so it cuts across IP and UA buckets.
 */
const globalBuckets = new Map<string, { count: number; windowStart: number }>();
export function rateLimitGlobal(
  key: string,
  maxPerWindow: number,
  windowMs: number,
): NextResponse | null {
  const now = Date.now();
  if (globalBuckets.size >= BUCKET_HARD_CAP) {
    for (const [k, b] of globalBuckets) {
      if (now - b.windowStart > windowMs) globalBuckets.delete(k);
    }
  }
  const bucket = globalBuckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    globalBuckets.set(key, { count: 1, windowStart: now });
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
