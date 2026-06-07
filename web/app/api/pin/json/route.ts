import { NextRequest, NextResponse } from "next/server";
import { pinJson, PinataError } from "@/lib/pinata";
import { rateLimit, rejectCrossOrigin } from "@/lib/apiGuard";

/**
 * POST /api/pin/json
 *
 * Body: any JSON. Returns `{ cid, uri }`.
 *
 * The frontend builds the token's metadata object (image, description,
 * socials, slotTwitterHandles, etc.) and posts it here. The returned `uri`
 * (`ipfs://CID`) is then passed to `createToken` / `createClankerV3` as the
 * metadataURI argument.
 */
export const runtime = "nodejs";

const MAX_JSON_BYTES = 100_000; // 100 KB - metadata is small key/value pairs

export async function POST(req: NextRequest) {
  // FSEC-003: same guards as the file route - cross-origin POST refused,
  // per-IP rate-limited.
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const rl = rateLimit(req, "pin-json", 10, 60_000);
  if (rl) return rl;
  try {
    const text = await req.text();
    if (text.length > MAX_JSON_BYTES) {
      return NextResponse.json(
        { error: `Metadata too large (max ${MAX_JSON_BYTES.toLocaleString()} bytes)` },
        { status: 413 },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Body is not valid JSON" }, { status: 400 });
    }
    const result = await pinJson(json);
    return NextResponse.json(result);
  } catch (e: any) {
    const status = e instanceof PinataError && e.status ? e.status : 500;
    return NextResponse.json({ error: e?.message ?? "Pin failed" }, { status });
  }
}
