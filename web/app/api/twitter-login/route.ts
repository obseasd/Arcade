import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { isAddress } from "viem";

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

  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token");
  const slotIndex = searchParams.get("slotIndex");
  const recipient = searchParams.get("recipient");

  if (!token || !isAddress(token)) {
    return NextResponse.json({ error: "Missing or invalid token" }, { status: 400 });
  }
  if (!slotIndex || isNaN(parseInt(slotIndex, 10))) {
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

  const res = NextResponse.redirect(authUrl.toString());
  res.cookies.set(`tw_state_${state}`, JSON.stringify(stateData), {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });
  return res;
}
