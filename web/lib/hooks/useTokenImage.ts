"use client";

import { useEffect, useState } from "react";
import { Address } from "viem";
import {
  parseInlineMetadata,
  resolveIpfs,
  type TokenMetadata,
} from "@/lib/metadata";
import { useTokenMetadataURI } from "./useTokenMetadataURI";

/**
 * Same resolution path as `useTokenImage`, but returns the full parsed
 * TokenMetadata JSON instead of just the image URL. Use when the caller needs
 * the description, socials, or slotTwitterHandles fields (eg the token detail
 * page header).
 */
export function useTokenMetadata(token: Address | undefined): {
  metadata: TokenMetadata | undefined;
  isLoading: boolean;
} {
  const { metadataURI, isLoading: uriLoading } = useTokenMetadataURI(token);
  const [metadata, setMetadata] = useState<TokenMetadata | undefined>(undefined);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!metadataURI) {
      setMetadata(undefined);
      setResolving(false);
      return;
    }
    // data: → parse inline.
    const inline = parseInlineMetadata(metadataURI);
    if (inline) {
      setMetadata(inline);
      setResolving(false);
      return;
    }
    // ipfs:// → fetch from gateway.
    if (!metadataURI.startsWith("ipfs://")) {
      setMetadata(undefined);
      setResolving(false);
      return;
    }
    const cached = jsonCache.get(metadataURI);
    if (cached !== undefined) {
      setMetadata(cached ?? undefined);
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    (async () => {
      const cid = metadataURI.slice("ipfs://".length);
      for (const gw of GATEWAYS) {
        try {
          const res = await fetch(`${gw}${cid}`, { cache: "force-cache" });
          if (!res.ok) continue;
          const json = (await res.json()) as TokenMetadata;
          jsonCache.set(metadataURI, json);
          if (!cancelled) {
            setMetadata(json);
            setResolving(false);
          }
          return;
        } catch {
          continue;
        }
      }
      jsonCache.set(metadataURI, null);
      if (!cancelled) {
        setMetadata(undefined);
        setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metadataURI]);

  return { metadata, isLoading: uriLoading || resolving };
}

/**
 * Resolves the displayable image URL for a launchpad token, handling all
 * three metadata-URI shapes the launchpad emits:
 *
 *   1. `data:application/json;base64,...` — parsed synchronously, image
 *      extracted from the inline JSON. Used by legacy tokens that bundled
 *      the entire metadata inline (~8 KB images, expensive in calldata).
 *   2. `ipfs://CID` — fetched once from a public gateway, parsed as JSON,
 *      image URL pulled out. Used by tokens launched after the Pinata
 *      externalization (current path). Image inside the JSON is itself
 *      `ipfs://...` and resolved through the same gateway.
 *   3. Direct URL ending in an image extension — returned as-is.
 *
 * Returns `undefined` while a remote fetch is in flight or when nothing
 * resolvable is found. Results are cached per metadataURI (module-level) so
 * the same token across multiple cards on the page only fetches once.
 */
const jsonCache = new Map<string, TokenMetadata | null>();

const GATEWAYS = [
  // Pinata public gateway (best for content pinned via pinata).
  "https://gateway.pinata.cloud/ipfs/",
  // ipfs.io fallback. Slower but resolves anything pinned by any provider.
  "https://ipfs.io/ipfs/",
];

export function useTokenImage(token: Address | undefined): {
  image: string | undefined;
  isLoading: boolean;
} {
  const { metadataURI, isLoading: uriLoading } = useTokenMetadataURI(token);
  const [image, setImage] = useState<string | undefined>(undefined);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!metadataURI) {
      setImage(undefined);
      setResolving(false);
      return;
    }

    // Path 1: inline data: URI — synchronous parse.
    const inline = parseInlineMetadata(metadataURI);
    if (inline) {
      setImage(inline.image ? resolveIpfs(inline.image) : undefined);
      setResolving(false);
      return;
    }

    // Path 3: direct image URL — return as-is.
    if (
      /^https?:\/\//.test(metadataURI) &&
      /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(metadataURI)
    ) {
      setImage(metadataURI);
      setResolving(false);
      return;
    }

    // Path 2: ipfs:// JSON — fetch + cache + extract image.
    if (!metadataURI.startsWith("ipfs://")) {
      setImage(undefined);
      setResolving(false);
      return;
    }
    const cached = jsonCache.get(metadataURI);
    if (cached !== undefined) {
      setImage(cached?.image ? resolveIpfs(cached.image) : undefined);
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    (async () => {
      const cid = metadataURI.slice("ipfs://".length);
      // Try each gateway in order; first one that succeeds wins.
      for (const gw of GATEWAYS) {
        try {
          const res = await fetch(`${gw}${cid}`, { cache: "force-cache" });
          if (!res.ok) continue;
          const json = (await res.json()) as TokenMetadata;
          jsonCache.set(metadataURI, json);
          if (!cancelled) {
            setImage(json.image ? resolveIpfs(json.image) : undefined);
            setResolving(false);
          }
          return;
        } catch {
          continue;
        }
      }
      // All gateways failed: cache null so we don't retry on every mount.
      jsonCache.set(metadataURI, null);
      if (!cancelled) {
        setImage(undefined);
        setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metadataURI]);

  return { image, isLoading: uriLoading || resolving };
}
