import { NextRequest, NextResponse } from "next/server";

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
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
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
