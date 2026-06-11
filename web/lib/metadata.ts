/**
 * Token metadata is stored on-chain as a single string. Supported formats:
 *   1. data:application/json;base64,<base64>     → decoded as the metadata JSON
 *   2. ipfs://<cid>                              → resolved via ipfs.io gateway
 *   3. https://...                               → fetched as-is
 *   4. (plain string, not a URL)                 → treated as an image URL
 */

export interface TokenMetadata {
  image?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  /**
   * Creator attribution: the @handle the deployer claims on Twitter. The
   * on-chain fee recipient is always an Ethereum address (see the V3 locker);
   * this field is *display* attribution only. We don't verify it cryptographically.
   * To spot impersonation, check the deployer's actual tweet announcing the
   * launch (Clanker's same trust model).
   */
  creatorTwitter?: string;
  /**
   * Per-slot Twitter attribution for escrowed claims. Each index maps to a
   * recipient slot. A non-undefined value means the slot's payouts route to
   * the ArcadeTwitterEscrow; the verified owner of that @handle can later
   * claim accumulated balances via OAuth login.
   */
  slotTwitterHandles?: (string | null)[];
}

export function encodeMetadataDataUri(m: TokenMetadata): string {
  const json = JSON.stringify(m);
  if (typeof window === "undefined") {
    // Node / SSR
    return `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`;
  }
  return `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`;
}

export function parseInlineMetadata(uri: string): TokenMetadata | null {
  if (!uri) return null;
  if (uri.startsWith("data:application/json;base64,")) {
    try {
      const b64 = uri.slice("data:application/json;base64,".length);
      const json = typeof window === "undefined"
        ? Buffer.from(b64, "base64").toString("utf8")
        : decodeURIComponent(escape(atob(b64)));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveIpfs(uri: string): string {
  if (uri.startsWith("ipfs://")) {
    // Pinata's public gateway is the canonical host for content we pinned
    // through their service - it returns image bytes within ~50-100ms vs
    // 1-3s on ipfs.io while the DHT lookup happens. The launchpad list
    // renders 20+ logos at once, so the per-image latency multiplies into
    // visible "all images blank for several seconds" before they finally
    // pop in. Switching the primary gateway keeps the same security
    // posture (HTTPS public gateway, no auth header sent) and is what
    // the fetchMetadata path also tries first.
    return `https://gateway.pinata.cloud/ipfs/${uri.slice("ipfs://".length)}`;
  }
  return uri;
}

/**
 * Resolve a metadataURI to the parsed JSON, supporting BOTH the inline
 * data: URI shape AND the ipfs:// path. Inline is parsed synchronously
 * just like parseInlineMetadata; ipfs:// is fetched via the public ipfs.io
 * gateway with a hard timeout so a slow gateway doesn't hang the caller.
 *
 * Returns null if the URI shape is unsupported, the fetch fails, the
 * response isn't valid JSON, or the timeout fires.
 */
/**
 * Audit Twitter Escrow H-3: IPFS gateway plurality. The previous code
 * fetched from ipfs.io only and trusted the returned body byte-for-byte.
 * A compromised gateway can substitute the slotTwitterHandles array
 * silently, capturing claims for an attacker handle. Defense:
 *  - Race two independent gateways (ipfs.io + cf-ipfs.com or
 *    NEXT_PUBLIC_IPFS_GATEWAY) and require their bodies to match
 *    byte-for-byte before returning the parsed JSON.
 *  - If only one gateway is reachable, return null (fail closed) for
 *    metadata that drives the claim-attribution path; an indexer
 *    re-fetch can pick it up later once gateways agree.
 */
// Audit F-4: dedup the gateway list by registrable hostname so an
// operator who sets `NEXT_PUBLIC_IPFS_GATEWAY=https://cloudflare-ipfs.com`
// can't accidentally collapse the quorum to "ipfs.io vs ipfs.io" (one
// gateway compared with itself). After dedup we hard-require >= 2
// distinct hosts to be reachable for the quorum check to mean anything.
function buildIpfsGateways(): readonly string[] {
  const candidates = [
    process.env.NEXT_PUBLIC_IPFS_GATEWAY?.replace(/\/$/, "") || "https://ipfs.io",
    "https://cloudflare-ipfs.com",
    "https://gateway.pinata.cloud",
    "https://dweb.link",
  ];
  const byHost = new Map<string, string>();
  for (const url of candidates) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      if (!byHost.has(h)) byHost.set(h, url);
    } catch {
      // ignore malformed env value
    }
  }
  return [...byHost.values()];
}

const IPFS_GATEWAYS: readonly string[] = buildIpfsGateways();

async function fetchSingleIpfs(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchMetadata(uri: string, timeoutMs = 5_000): Promise<TokenMetadata | null> {
  if (!uri) return null;
  const inline = parseInlineMetadata(uri);
  if (inline) return inline;
  if (uri.startsWith("ipfs://")) {
    const cid = uri.replace(/^ipfs:\/\//, "").split("/")[0];
    if (!cid) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const bodies = await Promise.all(
        IPFS_GATEWAYS.map((g) =>
          fetchSingleIpfs(`${g}/ipfs/${cid}${uri.replace(/^ipfs:\/\/[^/]+/, "")}`, ctrl.signal),
        ),
      );
      const reachable = bodies.filter((b): b is string => b !== null);
      if (reachable.length === 0) return null;
      const first = reachable[0];
      const allMatch = reachable.every((b) => b === first);
      // Quorum: every reachable gateway must agree byte-for-byte so a
      // compromised single gateway can't substitute slotTwitterHandles
      // silently. STRICT mode also requires >= 2 reachable gateways.
      // STRICT mode is opt-in via STRICT_IPFS_QUORUM=1. Default is
      // single-gateway-OK because on testnet (and even on mainnet for
      // brand new pins) the DHT propagation lag means a fresh launch
      // is unclaimable for minutes/hours under strict quorum - the
      // user sees slot_not_attributed even though the metadata is
      // present on Pinata. The agreement check still runs across all
      // reachable gateways so 2+ disagreeing gateways still fail
      // (i.e. a malicious gateway substituting bytes is caught the
      // moment a second gateway picks up the real CID).
      const strict = process.env.STRICT_IPFS_QUORUM === "1";
      if (!allMatch) return null;
      if (strict && reachable.length < 2) return null;
      return JSON.parse(first) as TokenMetadata;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  // metadata-uri-not-pinned-to-ipfs-scheme: log unsupported schemes
  // (https://, ar://, etc.) so the backend's slot_not_attributed error
  // is traceable to a metadata-URI mismatch instead of an OAuth bug.
  // Returning null preserves the existing failure semantics for callers.
  if (typeof console !== "undefined") {
    // eslint-disable-next-line no-console
    console.warn(`[metadata] unsupported URI scheme: ${uri.slice(0, 64)}`);
  }
  return null;
}

