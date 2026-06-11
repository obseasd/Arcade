import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { isAddress } from "viem";
import { rateLimit } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";

const TWITTER_AUTH_URL = "https://twitter.com/i/oauth2/authorize";

/**
 * Step 1 of the OAuth flow. Initiates the Twitter authorization.
 *
 * Query params:
 *   - token: ERC20 token address (used to look up the claim attribution)
 *   - slotIndex: which recipient slot to claim
 *   - recipient: the wallet that will receive the claimed fees
 *
 * Stores a signed cookie with the PKCE verifier and the params, then redirects
 * the user to Twitter's authorization page.
 *
 * CSRF protection: the GET has a side effect (sets a state cookie), which
 * react-doctor flagged. We can't switch to POST without breaking the
 * <a href> click flow OAuth needs, so we instead check Sec-Fetch-Site:
 * - "same-origin" (link click from our own page) -> allowed
 * - "none" (typed URL, bookmark) -> allowed
 * - "cross-site" / "same-site" (cross-origin <img>, iframe, etc.) -> blocked
 * Older browsers that don't send Sec-Fetch-Site fall through (fail open),
 * matching the modern OWASP guidance for legacy compat.
 */
export async function GET(req: NextRequest) {
  // twitter-recipient-phishing-csrf: tighter Sec-Fetch-Site check than the
  // shared apiGuard's "fail open on missing header". OAuth init takes a
  // user-supplied `recipient` that ends up in the EIP-712 Claim the
  // backend later signs, so any cross-origin path here is a phishing
  // vector. Block requests that don't come from our own UI (Sec-Fetch-
  // Site: same-origin) or a direct typed URL (Sec-Fetch-Site: none).
  // Browsers that don't send the header are rare in 2026; we explicitly
  // require it for this endpoint.
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite !== "same-origin" && fetchSite !== "none") {
    return NextResponse.json(
      { error: "Cross-origin OAuth init not allowed" },
      { status: 403 },
    );
  }

  // Defense-in-depth (2026-06-11): force the OAuth flow onto the canonical
  // (no-www) host BEFORE we set any cookies. The callback URL handed to
  // Twitter is always no-www (see canonicalization further down), so if the
  // user arrived on www.arcade.trading we'd be setting the state cookie on
  // a host that the callback never visits. The domain attr also covers this,
  // but a redirect-first approach is bulletproof against any browser that
  // treats Domain= conservatively (Brave shields, Safari ITP, etc.).
  if (req.nextUrl.hostname.startsWith("www.")) {
    const target = req.nextUrl.clone();
    target.hostname = req.nextUrl.hostname.slice(4);
    return NextResponse.redirect(target, 307);
  }

  // Audit F-8: validate critical server config BEFORE the rate limit so
  // a "server_misconfigured" response can't be distinguished from a
  // legitimate 429 by an external prober trying to fingerprint the
  // deployment's env state. Without this an attacker learns whether
  // ARCADE_OAUTH_STATE_SECRET / TWITTER_CLIENT_ID / TWITTER_CLIENT_SECRET
  // are set just by sweeping the route. Now everything looks like an
  // anonymous 500 with no body diff.
  const secret = process.env.ARCADE_OAUTH_STATE_SECRET || "";
  const clientIdEnv = process.env.TWITTER_CLIENT_ID || "";
  if (!secret || !clientIdEnv) {
    return new NextResponse(null, { status: 500 });
  }

  // twitter-login-state-cookie-spam-self-dos: rate-limit state-cookie
  // allocation. Without this, a same-origin XSS (or a buggy retry loop)
  // could spam tw_state_<state> cookies past the browser's per-origin
  // cookie quota and lock the user out of their own session. Same
  // bucket size as the callback endpoint (10/min) so honest retries
  // through the OAuth dance succeed.
  const rl = rateLimit(req, "twitter-login", 10, 60_000);
  if (rl) return rl;

  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token");
  const slotIndex = searchParams.get("slotIndex");
  const recipient = searchParams.get("recipient");

  if (!token || !isAddress(token)) {
    return NextResponse.json({ error: "Missing or invalid token" }, { status: 400 });
  }
  // slotindex-loose-parse: strict integer regex + 0..3 bound (escrow
  // currently exposes 4 slots; reject anything outside that band so a
  // malformed query never propagates as a negative / hex / scientific
  // value into the signed Claim payload).
  if (!slotIndex || !/^[0-3]$/.test(slotIndex)) {
    return NextResponse.json({ error: "Missing or invalid slotIndex" }, { status: 400 });
  }
  if (!recipient || !isAddress(recipient)) {
    return NextResponse.json({ error: "Missing or invalid recipient" }, { status: 400 });
  }

  const clientId = process.env.TWITTER_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "TWITTER_CLIENT_ID not configured" }, { status: 500 });
  }

  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  // Canonicalize the origin: Twitter rejects any redirect_uri that doesn't
  // exactly match a registered callback. We strip `www.` so both
  // https://arcade.trading and https://www.arcade.trading produce the same
  // callback URL, which then matches the single entry in the dev portal.
  const origin = req.nextUrl.origin.replace(/^(https?:\/\/)www\./, "$1");
  const callbackUrl = `${origin}/api/twitter-callback`;

  const authUrl = new URL(TWITTER_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("scope", "users.read tweet.read");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const stateData = {
    token: token.toLowerCase(),
    slotIndex: parseInt(slotIndex, 10),
    recipient: recipient.toLowerCase(),
    verifier,
    createdAt: Date.now(),
  };

  // Audit Twitter Escrow H-2: HMAC the state cookie value so a same-
  // origin cookie-tamper attempt (XSS or shared-device cookie swap)
  // can't substitute a different `recipient` without the HMAC failing.
  // The signing secret lives only in the server env; tamper attempts
  // can't reproduce a valid MAC. The secret is already validated above
  // (audit F-8) before the rate limit check.
  const stateJson = JSON.stringify(stateData);
  const mac = crypto.createHmac("sha256", secret).update(stateJson).digest("hex");
  const cookieValue = `${stateJson}.${mac}`;

  const res = NextResponse.redirect(authUrl.toString());
  // Regression fix (2026-06-11): the prior "strict" sameSite combined with
  // the www-stripping callback URL meant the cookie set on www.arcade.trading
  // never reached the canonical (no-www) callback host, AND strict-sameSite
  // blocks cookies on the Twitter -> arcade.trading top-level cross-site
  // redirect even on a matching host. The state param itself is already
  // crypto-random + HMAC'd (audit Twitter Escrow H-2), so an attacker forging
  // a callback URL still cannot mint a valid state cookie. `lax` is the
  // OAuth-standard sameSite for state cookies.
  const isArcadeHost = req.nextUrl.hostname.endsWith("arcade.trading");
  res.cookies.set(`tw_state_${state}`, cookieValue, {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax",
    domain: isArcadeHost ? "arcade.trading" : undefined,
    maxAge: 600,
    path: "/",
  });
  return res;
}
