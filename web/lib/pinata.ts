/**
 * Minimal Pinata REST client. Server-side only - never import from client code.
 *
 * Two endpoints we use:
 *   - pinFileToIPFS: upload a binary file, returns its CID
 *   - pinJSONToIPFS: upload a JSON object, returns its CID
 *
 * Authentication: a JWT generated in the Pinata dashboard. Free tier limit is
 * 1 GB total storage and 100 requests / 1m of pinning per minute, plenty for
 * an early launchpad. Set `PINATA_JWT` in the Vercel environment.
 *
 * Note we deliberately avoid the @pinata/sdk dependency: the REST surface we
 * need is tiny, fetch + FormData is sufficient, and skipping the SDK avoids
 * pulling Node-specific modules into the edge runtime.
 */

const PINATA_BASE = "https://api.pinata.cloud";

export interface PinResult {
  cid: string;
  /** `ipfs://CID` form, ready to drop into TokenCreated.metadataURI. */
  uri: string;
}

export class PinataError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = "PinataError";
  }
}

function jwt(): string {
  const token = process.env.PINATA_JWT;
  if (!token) {
    throw new PinataError(
      "PINATA_JWT is not configured on the server (add it to Vercel env vars).",
    );
  }
  return token;
}

/** Upload an arbitrary binary file (image, etc.) to Pinata. */
export async function pinFile(
  bytes: ArrayBuffer | Uint8Array,
  filename: string,
): Promise<PinResult> {
  // Cast to BlobPart-compatible: a Uint8Array view's underlying buffer can be
  // typed as SharedArrayBuffer in strict TS, which Blob doesn't accept. We
  // copy into a fresh ArrayBuffer view.
  const data: ArrayBuffer =
    bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
  const blob = new Blob([data]);
  const form = new FormData();
  form.append("file", blob, filename);
  // Pin metadata: a small label so the user can find the upload in the Pinata
  // dashboard later. Optional.
  form.append(
    "pinataMetadata",
    JSON.stringify({ name: filename, keyvalues: { source: "arcade-launch" } }),
  );
  const res = await fetch(`${PINATA_BASE}/pinning/pinFileToIPFS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt()}` },
    body: form,
  });
  return parseResponse(res);
}

/** Upload a JSON object as the token's metadata to Pinata. */
export async function pinJson(json: unknown): Promise<PinResult> {
  const res = await fetch(`${PINATA_BASE}/pinning/pinJSONToIPFS`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pinataContent: json,
      pinataMetadata: { name: "arcade-token-metadata.json", keyvalues: { source: "arcade-launch" } },
    }),
  });
  return parseResponse(res);
}

async function parseResponse(res: Response): Promise<PinResult> {
  const text = await res.text();
  if (!res.ok) {
    throw new PinataError(`Pinata pin failed (${res.status})`, res.status, text);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PinataError("Pinata returned non-JSON body", res.status, text);
  }
  const cid = parsed?.IpfsHash;
  if (typeof cid !== "string" || cid.length === 0) {
    throw new PinataError("Pinata response missing IpfsHash", res.status, text);
  }
  return { cid, uri: `ipfs://${cid}` };
}
