import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/**
 * GET /api/claim/payload
 *
 * One-shot read of the HttpOnly `arcade_claim_payload` cookie set by
 * /api/twitter-callback. The cookie carries the EIP-712 Claim signature
 * and amounts the user needs to submit to TwitterEscrowV3.authorize.
 *
 * Why: keeps the signature out of URL query params, browser history,
 * Referer, browser-sync, and clipboard managers. The /claim client
 * page calls this on mount; the cookie is cleared on first 200 so a
 * second tab opened against the same redirect can't replay.
 *
 * Same-origin only. The cookie is SameSite=Strict already, so cross-
 * site fetches don't carry it; the extra Sec-Fetch-Site check is
 * defense in depth.
 */
export const runtime = "nodejs";

const COOKIE = "arcade_claim_payload";

export async function GET(req: NextRequest) {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite !== "same-origin" && fetchSite !== "none") {
    return NextResponse.json(
      { error: "Cross-origin payload read not allowed" },
      { status: 403 },
    );
  }
  // Audit Twitter Escrow H-6: require a custom header any direct
  // `fetch()` from our own page can set, but a passive XSS payload
  // exfiltrating via <img src=> / <iframe> / window.open() cannot.
  // The /claim client page sets `x-arcade-claim: 1` on its fetch();
  // any cross-context exfil from same-origin XSS now needs to also
  // forge this header, which requires controlled execution in our
  // app context - if the attacker already has that, the cookie path
  // is the least of our problems anyway.
  const claimHeader = req.headers.get("x-arcade-claim");
  if (claimHeader !== "1") {
    return NextResponse.json({ error: "csrf_block" }, { status: 403 });
  }
  const raw = req.cookies.get(COOKIE)?.value;
  if (!raw) {
    return NextResponse.json({ error: "no_payload" }, { status: 404 });
  }
  // Audit F-9: verify the HMAC the twitter-callback route attached so a
  // same-origin XSS that managed to swap the cookie body before this
  // route reads it (recipient / amount swap) fails the MAC check here
  // and never reaches the client. Defense in depth on top of HttpOnly +
  // SameSite=Strict + the x-arcade-claim CSRF header above.
  const sepIdx = raw.lastIndexOf(".");
  if (sepIdx < 0) {
    const res = NextResponse.json({ error: "bad_payload" }, { status: 400 });
    res.cookies.delete(COOKIE);
    return res;
  }
  const body = raw.slice(0, sepIdx);
  const providedMac = raw.slice(sepIdx + 1);
  const secret = process.env.ARCADE_OAUTH_STATE_SECRET || "";
  if (!secret) {
    return new NextResponse(null, { status: 500 });
  }
  const expectedMac = crypto.createHmac("sha256", secret).update(body).digest("hex");
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
  if (!macOk) {
    const res = NextResponse.json({ error: "bad_payload" }, { status: 400 });
    res.cookies.delete(COOKIE);
    return res;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    const res = NextResponse.json({ error: "bad_payload" }, { status: 400 });
    res.cookies.delete(COOKIE);
    return res;
  }
  const res = NextResponse.json(payload);
  // One-shot: consume the cookie on the first successful read so a
  // user accidentally re-visiting /claim doesn't expose the same
  // sig to a third party who somehow got read access.
  res.cookies.delete(COOKIE);
  return res;
}
