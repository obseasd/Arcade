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
 */
export async function GET(req: NextRequest) {
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

  const origin = req.nextUrl.origin;
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
