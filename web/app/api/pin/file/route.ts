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

/** Sniff the first few bytes for known image signatures. Defends against
 *  client-supplied `Content-Type: image/png` on an HTML / JS / SVG payload
 *  (audit pin-file-mime-trusted-from-client). */
function detectImageMime(bytes: Uint8Array): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38 (GIF8)
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  // WEBP: RIFF????WEBP (4-7 are size, 8-11 = WEBP)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // SVG: starts with "<?xml" or "<svg" after whitespace
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) {
    // We reject SVG entirely below because SVG can carry JS; signal it as
    // SVG so the caller knows to reject.
    return "image/svg+xml";
  }
  return null;
}

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

  // pin-formdata-buffer-before-size-check: reject early when the
  // Content-Length header advertises a body larger than the cap, so the
  // multipart parser isn't asked to buffer up to Vercel's platform-level
  // limit (~4.5MB) before we can run the size check.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES + 2048) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES.toLocaleString()} bytes)` },
      { status: 413 },
    );
  }

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
    // sane. Accept the standard browser-supported set MINUS svg (which can
    // execute JS via inline event handlers and references).
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}` },
        { status: 415 },
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // pin-file-mime-trusted-from-client: verify the actual bytes match an
    // image signature, not just the client-supplied Content-Type header.
    const sniffed = detectImageMime(bytes);
    if (!sniffed || sniffed === "image/svg+xml") {
      return NextResponse.json(
        { error: "File content does not match an allowed image format" },
        { status: 415 },
      );
    }
    const result = await pinFile(bytes, file.name || "image");
    return NextResponse.json(result);
  } catch (e: any) {
    const status = e instanceof PinataError && e.status ? e.status : 500;
    return NextResponse.json({ error: e?.message ?? "Pin failed" }, { status });
  }
}
