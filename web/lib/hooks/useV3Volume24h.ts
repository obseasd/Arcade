"use client";

import { useEffect, useState } from "react";
import { Address } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/constants";
import { V3_SWAP_EVT as SWAP_EVT } from "@/lib/eventSignatures";
import { CHUNK_SMALL } from "@/lib/eventScan";

/** Per-call block window. Same conservative size used elsewhere on Arc RPC. */
const CHUNK = CHUNK_SMALL;
/** Last 24 h on Arc (~1 s blocks). */
const LOOKBACK = 86_400n;
/** 60-second module-level cache, keyed by pool. Avoids re-scanning 86k blocks
 *  on every render across token rows. */
const cache = new Map<string, { ts: number; value: bigint }>();
const TTL_MS = 60_000;

/**
 * 24-hour swap volume (USDC side) for a Clanker V3 pool, in 6-decimal raw
 * units. Returns `undefined` while loading, `0n` for WETH-paired pools (we
 * don't price WETH here), and the cumulative |USDC amount| otherwise.
 */
export function useV3Volume24h(pool: Address | undefined): {
  volume: bigint | undefined;
  isLoading: boolean;
} {
  const publicClient = usePublicClient();
  const [vol, setVol] = useState<bigint | undefined>(
    pool ? cache.get(pool.toLowerCase())?.value : undefined,
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!publicClient || !pool) {
      setVol(undefined);
      return;
    }
    const key = pool.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < TTL_MS) {
      setVol(hit.value);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const t0Raw = await publicClient.readContract({
          address: pool,
          abi: [
            {
              type: "function",
              name: "token0",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "address" }],
            },
          ] as const,
          functionName: "token0",
        });
        const usdcIsToken0 =
          (t0Raw as Address).toLowerCase() === ADDRESSES.usdc.toLowerCase();
        const t1Raw = await publicClient.readContract({
          address: pool,
          abi: [
            {
              type: "function",
              name: "token1",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "address" }],
            },
          ] as const,
          functionName: "token1",
        });
        const usdcIsToken1 =
          (t1Raw as Address).toLowerCase() === ADDRESSES.usdc.toLowerCase();
        if (!usdcIsToken0 && !usdcIsToken1) {
          // Non-USDC paired pool (eg WETH). We don't compute a USD figure here.
          cache.set(key, { ts: Date.now(), value: 0n });
          if (!cancelled) setVol(0n);
          return;
        }

        let end = latest;
        const target = latest > LOOKBACK ? latest - LOOKBACK : 0n;
        let sumUsdc = 0n;
        let errors = 0;
        while (end > target) {
          const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
          const from = start > target ? start : target;
          try {
            const logs = await publicClient.getLogs({
              address: pool,
              event: SWAP_EVT,
              fromBlock: from,
              toBlock: end,
            });
            for (const log of logs) {
              const a = usdcIsToken0
                ? (log.args.amount0 as bigint)
                : (log.args.amount1 as bigint);
              sumUsdc += a < 0n ? -a : a;
            }
          } catch {
            errors += 1;
            if (errors > 3) break;
          }
          if (from === 0n) break;
          end = from - 1n;
        }
        cache.set(key, { ts: Date.now(), value: sumUsdc });
        if (!cancelled) setVol(sumUsdc);
      } catch {
        if (!cancelled) setVol(undefined);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, pool]);

  return { volume: vol, isLoading };
}
