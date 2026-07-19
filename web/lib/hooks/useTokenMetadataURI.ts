"use client";

import { useQuery } from "@tanstack/react-query";
import { Address, parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import { getLaunchpadAddressList } from "@/lib/launchpadGenerations";
import { ADDRESSES } from "@/lib/constants";

const TOKEN_CREATED_EVT = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, uint8 mode, address creator2, uint16 creator2ShareBps, string name, string symbol, string metadataURI)",
);
// ArcadeHook (V4) tokens carry their metadataURI in TokenLaunched, emitted by
// the hook -- NOT TokenCreated on a legacy launchpad. Orphan callers (the V4
// token detail page) must scan this too or V4 logos/descriptions never resolve.
const TOKEN_LAUNCHED_EVT = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed creator, uint8 mode, string name, string symbol, string metadataURI)",
);

// 10k chunks match Alchemy's documented filtered-getLogs cap on free
// tier. Used to be 1k (public-Arc safe) which forced 500 windows/token
// and 15k calls per launchpad render. Even with this, the dominant
// cost is that TokenCard calls useTokenImage(addr) which re-runs this
// scan FOR EACH TOKEN even though useLaunchpadTokens already produced
// a metadataURI per token. The /launchpad page now passes that URI
// down (see TokenCard) so this duplicate scan only runs for orphan
// callers (token detail page, etc.) where the parent doesn't have
// the URI ready-to-hand.
const CHUNK = 10_000n;
const MAX_BACK = 500_000n;

/**
 * Returns the on-chain metadataURI for a launchpad token. Reads the
 * `TokenCreated` event for that token via chunked log queries. The launchpad
 * no longer stores `metadataURI` in state (saves ~5M gas per launch), so this
 * is the canonical way to fetch it.
 *
 * Backed by React Query, so multiple components asking for the same token's
 * URI share one scan + one cache entry. URIs are immutable post-launch, so
 * staleTime is Infinity - we never refetch.
 */
export function useTokenMetadataURI(
  token: Address | undefined,
  /** Override to disable the scan. Set to false from useTokenMetadata
   *  when the caller passed an explicit metadataURIOverride - no point
   *  burning a getLogs storm to re-derive what we already have. */
  enabled: boolean = true,
): {
  metadataURI: string | undefined;
  isLoading: boolean;
} {
  const publicClient = usePublicClient();
  const tokenKey = token?.toLowerCase();

  const { data, isLoading, isFetching } = useQuery<string | undefined>({
    queryKey: ["arcade", "tokenMetadataURI", tokenKey],
    enabled: enabled && !!publicClient && !!tokenKey,
    // URIs never change after the token is launched, so we want this in
    // cache forever. RQ defaults to a 5-minute stale window; Infinity
    // turns that off so the query never re-runs for the same token.
    staleTime: Infinity,
    gcTime: Infinity,
    // Chunked walk from head backwards. We early-exit the second a single
    // TokenCreated for `token` is found - one per token by contract design.
    queryFn: async ({ signal }) => {
      if (!publicClient || !token) return undefined;
      const latest = await publicClient.getBlockNumber();
      // Walk backwards from head in CHUNK-sized windows. Each window
      // queries ALL launchpad generations in one address-array getLogs
      // call instead of the previous single-address version - tokens
      // minted on an old launchpad (most of the Pump cards on screen
      // right now were created on a prior generation) emit their
      // TokenCreated event on THAT contract, not the current launchpad,
      // so a current-launchpad-only scan returned no hit and the image
      // fell back to the "?" placeholder. address-mode getLogs takes
      // up to ~100 addresses; we're at 8 generations * 1 contract
      // each = 8, well under the cap.
      const launchpads = getLaunchpadAddressList();
      const hook = ADDRESSES.arcadeHook;
      const hasHook = !!hook && hook !== "0x0000000000000000000000000000000000000000";
      if (launchpads.length === 0 && !hasHook) return "";
      let end = latest;
      let walked = 0n;
      while (walked < MAX_BACK) {
        if (signal.aborted) return undefined;
        const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
        try {
          // Scan both the legacy launchpads (TokenCreated) and the ArcadeHook
          // (TokenLaunched) in this window; return whichever yields the URI.
          const [createdLogs, launchedLogs] = await Promise.all([
            launchpads.length > 0
              ? publicClient.getLogs({ address: launchpads, event: TOKEN_CREATED_EVT, args: { token }, fromBlock: start, toBlock: end })
              : Promise.resolve([] as Awaited<ReturnType<typeof publicClient.getLogs>>),
            hasHook
              ? publicClient.getLogs({ address: hook, event: TOKEN_LAUNCHED_EVT, args: { token }, fromBlock: start, toBlock: end })
              : Promise.resolve([] as Awaited<ReturnType<typeof publicClient.getLogs>>),
          ]);
          if (createdLogs.length > 0) {
            return ((createdLogs[0] as { args: { metadataURI?: string } }).args.metadataURI) ?? "";
          }
          if (launchedLogs.length > 0) {
            return ((launchedLogs[0] as { args: { metadataURI?: string } }).args.metadataURI) ?? "";
          }
        } catch {
          // RPC range cap hit or transient failure; bail and return empty
          // rather than spin forever - the cache TTL is Infinity so a
          // future page navigation will retry from scratch.
          break;
        }
        if (start === 0n) break;
        walked += end - start + 1n;
        end = start - 1n;
      }
      return "";
    },
  });

  return { metadataURI: data, isLoading: isLoading || isFetching };
}
