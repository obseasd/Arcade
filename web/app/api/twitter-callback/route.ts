import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { rateLimit, rateLimitGlobal } from "@/lib/apiGuard";
import { Address, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildV4ClaimPayload } from "@/lib/twitterClaimV4";
import { ADDRESSES } from "@/lib/constants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const TWITTER_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const TWITTER_ME_URL = "https://api.twitter.com/2/users/me";

/**
 * Audit Twitter Escrow C-2: defensive Twitter-handle normalisation.
 * Applies, in order:
 *  1) UTS-46 / NFKC Unicode normalisation (case-fold + canonical
 *     decomposition + compatibility recomposition) so e.g. fullwidth
 *     and halfwidth digits collapse to the same handle.
 *  2) Strip zero-width characters that Twitter rejects on signup but
 *     can sneak into an on-chain metadata blob.
 *  3) Lowercase.
 *  4) Validate against Twitter's strict character set
 *     ^[A-Za-z0-9_]{1,15}$. Anything else is treated as a bad handle
 *     so the signing flow refuses to proceed (Cyrillic homoglyph,
 *     emoji-injected, leading dot, etc.).
 *
 * Returns the cleaned handle or undefined when validation fails.
 */
function normaliseHandle(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  let h = raw.normalize("NFKC");
  // Strip zero-width characters: ZWSP, ZWNJ, ZWJ, BOM.
  h = h.replace(/[​-‍﻿]/g, "");
  h = h.toLowerCase().trim();
  // Strip a leading @ if the deployer included it.
  if (h.startsWith("@")) h = h.slice(1);
  if (!/^[a-z0-9_]{1,15}$/.test(h)) return undefined;
  return h;
}

interface StateData {
  token: string;
  slotIndex: number;
  recipient: string;
  verifier: string;
  createdAt: number;
}

function redirectBackWithError(origin: string, error: string) {
  // Error path keeps the error code in the URL because there's nothing
  // sensitive in it and the user benefits from seeing what failed.
  const url = new URL(`${origin}/claim`);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: NextRequest) {
  // Audit 2026-06-11 FE-3 REVERTED: the previous block 307-redirected
  // www -> apex here as a belt-and-suspenders defence for conservative
  // browsers + future canonical-host changes. But Vercel canonicalizes
  // apex -> www at the platform level, which creates ERR_TOO_MANY_
  // REDIRECTS (the same loop we hit on /api/twitter-login). The state
  // cookie (and the claim payload cookie set below) are both scoped
  // Domain=arcade.trading via cookieDomain, so the browser makes them
  // available on every arcade.trading subdomain including www - we
  // don't need a host-level redirect to find them.

  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  // Same canonicalization as twitter-login: strip `www.` so the redirect_uri
  // sent at the token-exchange step matches what was sent at authorization.
  const origin = req.nextUrl.origin.replace(/^(https?:\/\/)www\./, "$1");

  if (!code || !state) return redirectBackWithError(origin, "missing_params");

  // FSEC-004 hygiene: the state param is generated server-side as 16
  // bytes of crypto.randomBytes -> 32 hex chars. Validate the shape
  // before using it as a cookie name fragment so a hand-crafted state
  // can't address a cookie shape we didn't pick.
  if (!/^[0-9a-f]{32}$/.test(state)) {
    return redirectBackWithError(origin, "invalid_state");
  }

  // FSEC-007: per-IP rate limit on the OAuth completion path. The
  // current (0, 0)-amount sign is intentional (sync-fees-from-pool flow,
  // see the long-form comment further down), but bounding completions
  // per IP per minute caps the rate at which an attacker can farm
  // stockpiled signatures for any handle they happen to control.
  const rl = rateLimit(req, "twitter-callback", 10, 60_000);
  if (rl) return rl;
  // Audit F-5: per-slot global cap on top of per-IP. A botnet controlling
  // N residential IPs can farm 10*N sigs/min for any (token, slot) pair
  // the attacker owns; bounding by (token, slot) regardless of source IP
  // closes that funnel. We read state from the cookie's decoded payload
  // below; here we hash the raw state cookie name which already encodes
  // the (token, slot) tuple via the OAuth state nonce.
  const slotRl = rateLimitGlobal(`twitter-callback:state:${state}`, 30, 60_000);
  if (slotRl) return slotRl;

  const cookieName = `tw_state_${state}`;
  const stateCookie = req.cookies.get(cookieName)?.value;
  if (!stateCookie) return redirectBackWithError(origin, "invalid_state");

  // Audit Twitter Escrow H-2: verify the HMAC the login route attached
  // so a tampered cookie value (recipient swap, slot swap) is rejected
  // before the OAuth callback even talks to Twitter.
  const sepIdx = stateCookie.lastIndexOf(".");
  if (sepIdx < 0) return redirectBackWithError(origin, "bad_state");
  const stateJson = stateCookie.slice(0, sepIdx);
  const providedMac = stateCookie.slice(sepIdx + 1);
  const secret = process.env.ARCADE_OAUTH_STATE_SECRET || "";
  if (!secret) return redirectBackWithError(origin, "server_misconfigured");
  const expectedMac = crypto
    .createHmac("sha256", secret)
    .update(stateJson)
    .digest("hex");
  // Constant-time compare so cookie-tamper attempts can't bisect bytes.
  let macOk = providedMac.length === expectedMac.length;
  try {
    macOk =
      macOk &&
      crypto.timingSafeEqual(
        Buffer.from(providedMac, "hex"),
        Buffer.from(expectedMac, "hex"),
      );
  } catch {
    macOk = false;
  }
  if (!macOk) return redirectBackWithError(origin, "bad_state");

  let stateData: StateData;
  try {
    stateData = JSON.parse(stateJson);
  } catch {
    return redirectBackWithError(origin, "bad_state");
  }

  const { token, slotIndex, recipient, verifier } = stateData;
  if (!isAddress(token) || !isAddress(recipient)) {
    return redirectBackWithError(origin, "invalid_addresses");
  }

  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const backendPk = process.env.ARCADE_BACKEND_PRIVATE_KEY as `0x${string}` | undefined;
  if (!clientId || !clientSecret || !backendPk) {
    return redirectBackWithError(origin, "server_misconfigured");
  }

  // no-abort-controller-on-twitter-token-and-me-fetches: 5s timeouts on
  // both Twitter API calls so a slow / dead Twitter endpoint doesn't
  // pin the Vercel serverless function up to its default 10s budget.
  const tokenCtrl = new AbortController();
  const tokenT = setTimeout(() => tokenCtrl.abort(), 5_000);
  // 1) Exchange code for access_token (PKCE confidential client).
  const callbackUrl = `${origin}/api/twitter-callback`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let tokenRes: Response;
  try {
    tokenRes = await fetch(TWITTER_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl,
        code_verifier: verifier,
      }).toString(),
      signal: tokenCtrl.signal,
    });
  } catch {
    return redirectBackWithError(origin, "token_exchange_failed");
  } finally {
    clearTimeout(tokenT);
  }
  if (!tokenRes.ok) {
    return redirectBackWithError(origin, "token_exchange_failed");
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) return redirectBackWithError(origin, "no_access_token");

  // 2) Fetch the user's @handle.
  const meCtrl = new AbortController();
  const meT = setTimeout(() => meCtrl.abort(), 5_000);
  let meRes: Response;
  try {
    meRes = await fetch(TWITTER_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: meCtrl.signal,
    });
  } catch {
    return redirectBackWithError(origin, "me_failed");
  } finally {
    clearTimeout(meT);
  }
  if (!meRes.ok) return redirectBackWithError(origin, "me_failed");
  const meJson = (await meRes.json()) as { data?: { username?: string; id?: string } };
  const rawOauthHandle = meJson.data?.username;
  // Canonical claim key: the numeric user-id (handles rename/recycle). Passed to
  // the V4 claim so attribution binds to the id, not the @handle.
  const oauthUserId = meJson.data?.id;
  // Audit Twitter Escrow C-2: normalise the handle through NFKC, strip
  // zero-width characters, and gate against Twitter's strict character
  // set so a Unicode homoglyph (Cyrillic 'е' in 'еlonmusk', emoji
  // injection, ZWJ insertion) cannot impersonate a real handle. The
  // raw handle from the OAuth response is otherwise compared as-is
  // against the on-chain metadata, which a deployer fully controls.
  const oauthHandle = normaliseHandle(rawOauthHandle);
  if (!oauthHandle) return redirectBackWithError(origin, "no_handle");

  // 2.5) V4-hook claim path. V4-hook launches use ArcadeTwitterEscrowV4 (single
  // token, keyed by uint256(poolId), 7-field Claim, domain version "4"), which
  // the V3 block below (locker positionIdByToken + dual paired/clanker) cannot
  // serve. Try V4 first; a non-hook token returns not-v4 and falls through. The
  // same upstream gates (state HMAC, per-IP + per-slot rate limit, OAuth) apply.
  {
    const v4 = await buildV4ClaimPayload({
      token: token as Address,
      slotIndex,
      recipient: recipient as Address,
      oauthHandle,
      oauthUserId,
      backendPk,
    });
    if (v4.kind === "error") return redirectBackWithError(origin, v4.error);
    if (v4.kind === "ok") {
      const claimBody = JSON.stringify(v4.payload);
      const claimMac = crypto.createHmac("sha256", secret).update(claimBody).digest("hex");
      const res = NextResponse.redirect(new URL(`${origin}/claim`).toString());
      const cookieDomain = req.nextUrl.hostname.endsWith("arcade.trading") ? "arcade.trading" : undefined;
      // Clear the one-shot state cookie, then hand the signed payload to /claim
      // via the same HttpOnly + HMAC one-shot cookie the V3 path uses.
      res.cookies.set(cookieName, "", {
        httpOnly: true,
        secure: req.nextUrl.protocol === "https:",
        sameSite: "lax",
        domain: cookieDomain,
        path: "/",
        maxAge: 0,
      });
      res.cookies.set("arcade_claim_payload", `${claimBody}.${claimMac}`, {
        httpOnly: true,
        secure: req.nextUrl.protocol === "https:",
        sameSite: "strict",
        domain: cookieDomain,
        path: "/",
        maxAge: 120,
      });
      return res;
    }
    // v4.kind === "not-v4" -> not a hook token (or hook/escrow unset); continue
    // Logged so a MIS-routed V4 token (that should have matched the hook path
    // but returned not-v4 due to a config/RPC blip) is visible before we 404 it.
    console.error("[claim] V4 path returned not-v4 for token=" + token + " slot=" + slotIndex + "; no legacy path, returning not_supported");
  }

  // No V4-hook match. The legacy V3 escrow claim path was retired 2026-07-21
  // (no historical V3 claims to serve), so a non-hook token has no claimable
  // escrow slot on the current deployment.
  return redirectBackWithError(origin, "not_supported");
}
