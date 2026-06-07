"use client";

import { useQuery } from "@tanstack/react-query";
import { Address } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/constants";
import { V3_SWAP_EVT as SWAP_EVT } from "@/lib/eventSignatures";
import { CHUNK_SMALL } from "@/lib/eventScan";

/** Per-call block window. Same conservative size used elsewhere on Arc RPC. */
const CHUNK = CHUNK_SMALL;
/** Last 24 h on Arc (~1 s blocks). */
const LOOKBACK = 86_400n;
/** Cache window for the React Query staleTime. */
const TTL_MS = 60_000;

/**
 * 24-hour swap volume (USDC side) for a Clanker V3 pool, in 6-decimal raw
 * units. Returns `undefined` while loading, `0n` for non-USDC paired pools,
 * and the cumulative |USDC amount| otherwise.
 *
 * Backed by React Query so the same pool's scan is shared across all rows
 * rendering the same pool address. The 86k-block scan is the most expensive
 * thing this hook does; deduping it across the explore page is the whole
 * point of the migration (audit ARCH-007).
 */
export function useV3Volume24h(pool: Address | undefined): {
  volume: bigint | undefined;
  isLoading: boolean;
} {
  const publicClient = usePublicClient();

  const { data, isLoading, isFetching } = useQuery<bigint | undefined>({
    queryKey: ["arcade", "v3-volume-24h", pool?.toLowerCase() ?? null],
    enabled: !!publicClient && !!pool,
    staleTime: TTL_MS,
    gcTime: TTL_MS * 5,
    queryFn: async () => {
      if (!publicClient || !pool) return undefined;
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
        return 0n;
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
      return sumUsdc;
    },
  });

  return {
    volume: data,
    isLoading: !!pool && (isLoading || isFetching),
  };
}
