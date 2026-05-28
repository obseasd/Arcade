"use client";

import { useEffect, useState } from "react";
import { Address, parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/constants";

const TOKEN_CREATED_EVT = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, uint8 mode, address creator2, uint16 creator2ShareBps, string name, string symbol, string metadataURI)",
);

const CHUNK = 1_000n;
const MAX_BACK = 500_000n;

/**
 * Returns the on-chain metadataURI for a launchpad token. Reads the
 * `TokenCreated` event for that token via chunked log queries. The launchpad
 * no longer stores `metadataURI` in state (saves ~5M gas per launch), so this
 * is the canonical way to fetch it.
 *
 * Cached per token in a module-level Map: a token's metadataURI never changes
 * after launch, so we never re-fetch it.
 */
const cache = new Map<string, string>();

export function useTokenMetadataURI(token: Address | undefined): {
  metadataURI: string | undefined;
  isLoading: boolean;
} {
  const publicClient = usePublicClient();
  const [uri, setUri] = useState<string | undefined>(
    token ? cache.get(token.toLowerCase()) : undefined,
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!publicClient || !token) {
      setUri(undefined);
      setIsLoading(false);
      return;
    }
    const cached = cache.get(token.toLowerCase());
    if (cached !== undefined) {
      setUri(cached);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        let end = latest;
        let walked = 0n;
        while (walked < MAX_BACK) {
          const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
          try {
            const logs = await publicClient.getLogs({
              address: ADDRESSES.launchpad,
              event: TOKEN_CREATED_EVT,
              args: { token },
              fromBlock: start,
              toBlock: end,
            });
            if (logs.length > 0) {
              const value = (logs[0].args.metadataURI as string) ?? "";
              cache.set(token.toLowerCase(), value);
              if (!cancelled) setUri(value);
              return;
            }
          } catch {
            break;
          }
          if (start === 0n) break;
          walked += end - start + 1n;
          end = start - 1n;
        }
        if (!cancelled) setUri("");
      } catch {
        if (!cancelled) setUri(undefined);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token]);

  return { metadataURI: uri, isLoading };
}
