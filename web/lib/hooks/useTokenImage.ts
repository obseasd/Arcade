"use client";

import { useQuery } from "@tanstack/react-query";
import { Address } from "viem";
import {
  parseInlineMetadata,
  resolveIpfs,
  ipfsGatewayUrls,
  type TokenMetadata,
} from "@/lib/metadata";
import { useTokenMetadataURI } from "./useTokenMetadataURI";

/** Fetch + parse a token's metadata JSON. The result is what
 *  `useTokenMetadata` / `useTokenImage` ultimately derive from. */
async function resolveMetadata(
  metadataURI: string,
  signal: AbortSignal,
): Promise<TokenMetadata | null> {
  // Path 1: inline data:application/json;base64,... - parse sync.
  const inline = parseInlineMetadata(metadataURI);
  if (inline) return inline;

  // Path 3: direct image URL ending in .png/.jpg/... - synthesise a minimal
  // metadata object so downstream `useTokenImage` can still extract the
  // image. The other fields are blank because we never had them.
  if (
    /^https?:\/\//.test(metadataURI) &&
    /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(metadataURI)
  ) {
    return { image: metadataURI } as TokenMetadata;
  }

  // Path 2: ipfs://CID - try the gateways in ORDER (first ok wins). Uses the
  // SAME env-first fallback list as the image bytes (NEXT_PUBLIC_IPFS_GATEWAY,
  // then ipfs.io / dweb.link / pinata) so a fresh pin that the shared, heavily
  // 429-rate-limited pinata gateway hasn't served yet still resolves via a
  // public gateway instead of leaving the token image blank (image bug fix).
  if (!metadataURI.startsWith("ipfs://")) return null;
  for (const url of ipfsGatewayUrls(metadataURI)) {
    if (signal.aborted) return null;
    try {
      // FSEC-005: no `cache: "force-cache"` so a compromised gateway / DNS
      // poisoning event can't persist a malicious metadata JSON in the user's
      // browser. React Query dedupes in-flight requests by queryKey (the
      // metadataURI), so the same URI never double-fetches within a session.
      const res = await fetch(url, { signal });
      if (!res.ok) continue;
      return (await res.json()) as TokenMetadata;
    } catch {
      // Network error / aborted; try the next gateway.
      continue;
    }
  }
  return null;
}

/**
 * Returns the full parsed TokenMetadata JSON. Use when the caller needs the
 * description, socials, or slotTwitterHandles fields (eg the token detail
 * page header). For just the image URL, prefer `useTokenImage` which avoids
 * re-running the JSON resolution if the same URI is already cached.
 *
 * Backed by React Query - all consumers of the same metadataURI share one
 * fetch. Since metadata JSONs at a given URI are immutable, staleTime is
 * Infinity.
 */
export function useTokenMetadata(
  token: Address | undefined,
  /** Skip the per-token getLogs scan when the URI is already known. */
  metadataURIOverride?: string,
): {
  metadata: TokenMetadata | undefined;
  isLoading: boolean;
} {
  const scanned = useTokenMetadataURI(token, !metadataURIOverride);
  const metadataURI = metadataURIOverride ?? scanned.metadataURI;
  const uriLoading = !metadataURIOverride && scanned.isLoading;

  const { data, isLoading, isFetching } = useQuery<TokenMetadata | null>({
    queryKey: ["arcade", "tokenMetadata", metadataURI],
    enabled: !!metadataURI,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: ({ signal }) => resolveMetadata(metadataURI as string, signal),
  });

  return {
    metadata: data ?? undefined,
    isLoading: uriLoading || (!!metadataURI && (isLoading || isFetching)),
  };
}

/**
 * Resolves the displayable image URL for a launchpad token, handling all
 * three metadata-URI shapes the launchpad emits:
 *
 *   1. `data:application/json;base64,...` - parsed synchronously, image
 *      extracted from the inline JSON. Used by legacy tokens that bundled
 *      the entire metadata inline (~8 KB images, expensive in calldata).
 *   2. `ipfs://CID` - fetched once from a public gateway, parsed as JSON,
 *      image URL pulled out. Used by tokens launched after the Pinata
 *      externalization (current path). Image inside the JSON is itself
 *      `ipfs://...` and resolved through the same gateway.
 *   3. Direct URL ending in an image extension - returned as-is.
 *
 * Returns `undefined` while a remote fetch is in flight or when nothing
 * resolvable is found. Builds on `useTokenMetadata` so the JSON fetch is
 * shared with any caller that also needs the description / socials.
 */
export function useTokenImage(
  token: Address | undefined,
  /** Optional metadataURI override. When the caller already has the
   *  URI in hand (e.g. /launchpad receives one per token from the
   *  useLaunchpadTokens cross-generation scan), pass it here so the
   *  hook skips its own per-token getLogs scan and goes straight to
   *  JSON resolution. This is the difference between 30 launchpad
   *  cards firing 30 parallel metadataURI scans and 0. */
  metadataURIOverride?: string,
): {
  image: string | undefined;
  isLoading: boolean;
} {
  const { metadata, isLoading } = useTokenMetadata(token, metadataURIOverride);
  const image = metadata?.image ? resolveIpfs(metadata.image) : undefined;
  return { image, isLoading };
}
