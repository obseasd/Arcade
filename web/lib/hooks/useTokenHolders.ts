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

/** 90-second cache per token. Once a token's holders have been computed by
 *  the adaptive scan, subsequent loads within the TTL render instantly. */
const cache = new Map<string, CacheEntry>();
const TTL_MS = 90_000;

/** Two-phase adaptive scan: a small fast window for the immediate render, then
 *  a longer background window that fills in older history. Tuned for Arc's 1s
 *  block time. */
const CHUNK = 5_000n;
const FAST_LOOKBACK = 5_000n; // ~1.4h on Arc, renders in ~1s
const FULL_LOOKBACK = 100_000n; // ~28h, completes silently in the background

/** Holders with less than one whole token are treated as dust and dropped from
 *  the list. The launchpad swept-rounding leftover after `lockSingleSided` lands
 *  here (typically a few wei) and would otherwise show as a confusing "0" row. */
const DUST_THRESHOLD_WEI = 10n ** 18n;

/**
 * Builds the holder list for an ERC20 token by replaying Transfer events. For
 * each transfer, we mutate a balance Map; we filter out the zero address and
 * any addresses with a final balance below DUST_THRESHOLD_WEI. Sort by balance
 * desc.
 *
 * Adaptive scan strategy (see CHUNK / FAST_LOOKBACK / FULL_LOOKBACK):
 *   1. Scan the most recent ~1.4h of blocks → first render (~1s on Arc RPC)
 *   2. Continue scanning back to ~28h in the background, updating the list
 *      when the extended scan completes. Cached for 90s.
 *
 * Trade-off: for tokens with transfers older than 28h that have stayed put,
 * those holders will still be missed. That's the same limitation as before but
 * with 6x the coverage, and the indexer roadmap (post-mainnet) replaces this
 * entirely.
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
        const balances = new Map<string, bigint>();
        const fastTarget = latest > FAST_LOOKBACK ? latest - FAST_LOOKBACK : 0n;
        const fullTarget = latest > FULL_LOOKBACK ? latest - FULL_LOOKBACK : 0n;

        // -------- Phase 1: fast window for immediate render -----------------
        let end = latest;
        let errors = 0;
        while (end > fastTarget) {
          const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
          const from = start > fastTarget ? start : fastTarget;
          try {
            const logs = await publicClient.getLogs({
              address: token,
              event: TRANSFER_EVT,
              fromBlock: from,
              toBlock: end,
            });
            applyLogs(logs, balances);
          } catch {
            errors += 1;
            if (errors > 3) break;
          }
          if (from === 0n) break;
          end = from - 1n;
        }

        if (!cancelled) {
          setHolders(mapToHolders(balances, totalSupply));
          setIsLoading(false);
        }

        // -------- Phase 2: extend in background ------------------------------
        // Already at the end of available history if `end <= fullTarget`, skip.
        let extendedErrors = 0;
        while (end > fullTarget && !cancelled) {
          const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
          const from = start > fullTarget ? start : fullTarget;
          try {
            const logs = await publicClient.getLogs({
              address: token,
              event: TRANSFER_EVT,
              fromBlock: from,
              toBlock: end,
            });
            applyLogs(logs, balances);
          } catch {
            extendedErrors += 1;
            if (extendedErrors > 3) break;
          }
          if (from === 0n) break;
          end = from - 1n;
        }

        if (!cancelled) {
          const final = mapToHolders(balances, totalSupply);
          // Cache the full extended result so subsequent loads stay snappy.
          cache.set(key, { ts: Date.now(), holders: final });
          setHolders(final);
        }
      } catch {
        if (!cancelled) {
          setHolders([]);
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token, totalSupply]);

  return { holders, totalHolders: holders.length, isLoading };
}

function applyLogs(logs: any[], balances: Map<string, bigint>) {
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
}

function mapToHolders(balances: Map<string, bigint>, totalSupply: bigint): Holder[] {
  const out: Holder[] = [];
  for (const [addr, bal] of balances) {
    if (bal < DUST_THRESHOLD_WEI) continue;
    const pct = totalSupply > 0n ? Number((bal * 10_000n) / totalSupply) / 100 : 0;
    out.push({ address: addr as Address, balanceRaw: bal, pctOfSupply: pct });
  }
  out.sort((a, b) => Number(b.balanceRaw - a.balanceRaw));
  return out;
}
