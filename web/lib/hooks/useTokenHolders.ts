"use client";

import { useEffect, useState } from "react";
import { Address, parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

const TRANSFER_EVT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export interface Holder {
  address: Address;
  balanceRaw: bigint;
  /** balanceRaw / totalSupply * 100, 0..100. */
  pctOfSupply: number;
}

interface CacheEntry {
  ts: number;
  holders: Holder[];
}

/** 90-second cache per token. Scanning Transfer events is expensive on Arc; we
 *  cache aggressively because holder distribution doesn't shift second-to-second. */
const cache = new Map<string, CacheEntry>();
const TTL_MS = 90_000;
const CHUNK = 1_000n;
const MAX_LOOKBACK = 500_000n;

/**
 * Builds the holder list for an ERC20 token by replaying Transfer events. For
 * each transfer, we mutate a balance Map; we filter out the zero address and
 * any addresses with a final balance of 0. Sort by balance desc.
 *
 * Trade-offs: this is O(transfers) RPC work, capped at 500k blocks back. For
 * very active tokens we may miss the longest-tail holders; the panel still
 * surfaces the top of the distribution correctly.
 */
export function useTokenHolders(
  token: Address | undefined,
  totalSupply: bigint,
): { holders: Holder[]; totalHolders: number; isLoading: boolean } {
  const publicClient = usePublicClient();
  const cached = token ? cache.get(token.toLowerCase()) : undefined;
  const [holders, setHolders] = useState<Holder[]>(cached?.holders ?? []);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!publicClient || !token) {
      setHolders([]);
      return;
    }
    const key = token.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < TTL_MS) {
      setHolders(hit.holders);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const target = latest > MAX_LOOKBACK ? latest - MAX_LOOKBACK : 0n;
        const balances = new Map<string, bigint>();
        let end = latest;
        let errors = 0;
        while (end > target) {
          const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
          const from = start > target ? start : target;
          try {
            const logs = await publicClient.getLogs({
              address: token,
              event: TRANSFER_EVT,
              fromBlock: from,
              toBlock: end,
            });
            for (const log of logs) {
              const fromAddr = (log.args.from as Address)?.toLowerCase() ?? ZERO;
              const toAddr = (log.args.to as Address)?.toLowerCase() ?? ZERO;
              const value = (log.args.value as bigint) ?? 0n;
              if (fromAddr !== ZERO) {
                balances.set(fromAddr, (balances.get(fromAddr) ?? 0n) - value);
              }
              if (toAddr !== ZERO) {
                balances.set(toAddr, (balances.get(toAddr) ?? 0n) + value);
              }
            }
          } catch {
            errors += 1;
            if (errors > 3) break;
          }
          if (from === 0n) break;
          end = from - 1n;
        }

        const out: Holder[] = [];
        for (const [addr, bal] of balances) {
          if (bal <= 0n) continue;
          const pct =
            totalSupply > 0n ? Number((bal * 10_000n) / totalSupply) / 100 : 0;
          out.push({ address: addr as Address, balanceRaw: bal, pctOfSupply: pct });
        }
        out.sort((a, b) => Number(b.balanceRaw - a.balanceRaw));
        cache.set(key, { ts: Date.now(), holders: out });
        if (!cancelled) setHolders(out);
      } catch {
        if (!cancelled) setHolders([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token, totalSupply]);

  return { holders, totalHolders: holders.length, isLoading };
}
