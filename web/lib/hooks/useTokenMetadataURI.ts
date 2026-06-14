"use client";

import { useQuery } from "@tanstack/react-query";
import { Address, parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import { getLaunchpadAddressList } from "@/lib/launchpadGenerations";

const TOKEN_CREATED_EVT = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, uint8 mode, address creator2, uint16 creator2ShareBps, string name, string symbol, string metadataURI)",
);

// Bumped from 1k → 50k after the Alchemy switch. Public Arc RPC capped
// getLogs at ~1-5k blocks per call, which forced this hook into 500
// chunks/token. With 30+ tokens visible on /launchpad each firing its
// own scan, that produced ~15,000 getLogs calls per cold render and
// blew straight past Alchemy's 300 CU/s free-tier ceiling. 50k chunks
// reduce per-token scans to ~10 windows, dropping the cold-load storm
// 50x and letting metadataURI resolution actually finish under the
// rate limit.
const CHUNK = 50_000n;
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
export function useTokenMetadataURI(token: Address | undefined): {
  metadataURI: string | undefined;
  isLoading: boolean;
} {
  const publicClient = usePublicClient();
  const tokenKey = token?.toLowerCase();

  const { data, isLoading, isFetching } = useQuery<string | undefined>({
    queryKey: ["arcade", "tokenMetadataURI", tokenKey],
    enabled: !!publicClient && !!tokenKey,
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
      if (launchpads.length === 0) return "";
      let end = latest;
      let walked = 0n;
      while (walked < MAX_BACK) {
        if (signal.aborted) return undefined;
        const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
        try {
          const logs = await publicClient.getLogs({
            address: launchpads,
            event: TOKEN_CREATED_EVT,
            args: { token },
            fromBlock: start,
            toBlock: end,
          });
          if (logs.length > 0) {
            return (logs[0].args.metadataURI as string) ?? "";
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
