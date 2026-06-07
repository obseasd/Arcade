import { NextRequest, NextResponse } from "next/server";
import { pinFile, PinataError } from "@/lib/pinata";
import { rateLimit, rejectCrossOrigin } from "@/lib/apiGuard";

/**
 * POST /api/pin/file
 *
 * Multipart upload: a single field named `file`. Returns `{ cid, uri }` where
 * `uri = ipfs://CID`. The frontend stores `uri` as the token's image URL in
 * the metadata JSON it later submits via /api/pin/json.
 *
 * Size cap: 1 MB. The launchpad image is shown as a small avatar everywhere;
 * anything larger is excess and would chew through the Pinata free tier
 * faster than necessary.
 */
const MAX_BYTES = 1_000_000;

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // FSEC-003: refuse cross-origin POSTs so an attacker can't burn the
  // Pinata quota from a hidden auto-submitting form on any third-party
  // site. Modern browsers send `Sec-Fetch-Site`; older clients fail
  // open. Then a per-IP rate limit (5 pins / 60s) caps the worst
  // case if the header check passes for some reason.
  const csrf = rejectCrossOrigin(req);
  if (csrf) return csrf;
  const rl = rateLimit(req, "pin-file", 5, 60_000);
  if (rl) return rl;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File too large (max ${MAX_BYTES.toLocaleString()} bytes)` },
        { status: 413 },
      );
    }
    // Reject anything that isn't an image MIME so the launchpad logo stays
    // sane. Accept the standard browser-supported set.
    if (!/^image\/(png|jpeg|jpg|webp|gif|svg\+xml)$/i.test(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}` },
        { status: 415 },
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await pinFile(bytes, file.name || "image");
    return NextResponse.json(result);
  } catch (e: any) {
    const status = e instanceof PinataError && e.status ? e.status : 500;
    return NextResponse.json({ error: e?.message ?? "Pin failed" }, { status });
  }
}
