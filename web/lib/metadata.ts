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
   * this field is *display* attribution only. We don't verify it cryptographically
   * — to spot impersonation, check the deployer's actual tweet announcing the
   * launch (Clanker's same trust model).
   */
  creatorTwitter?: string;
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
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  }
  return uri;
}

/**
 * Best-effort: returns just the image URL given the on-chain metadataURI.
 * Doesn't make network calls - for inline metadata it parses synchronously,
 * for URI-based metadata it returns the URI itself (caller can fetch).
 */
export function getImageUrl(metadataURI: string): string | undefined {
  if (!metadataURI) return undefined;
  const inline = parseInlineMetadata(metadataURI);
  if (inline) return inline.image ? resolveIpfs(inline.image) : undefined;
  // Heuristic: looks like a direct image URL?
  if (/^https?:\/\//.test(metadataURI) && /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(metadataURI)) {
    return metadataURI;
  }
  return undefined;
}
