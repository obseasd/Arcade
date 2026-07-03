"use client";

import { useQuery } from "@tanstack/react-query";
import { Address } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/constants";
import { BUY_EVT, SELL_EVT, V3_SWAP_EVT } from "@/lib/eventSignatures";
import { CHUNK_SMALL, MAX_BACK_TRADES, scanLogsChunked } from "@/lib/eventScan";

/**
 * Cumulative USDC trading volume for a launchpad token, in 6-decimal raw units.
 *
 * - PUMP / Arcade (curve): sums `Buy.usdcIn` + `Sell.usdcOut` from the launchpad.
 * - Clanker V3 (USDC-paired): sums |amountX| where X is the USDC side of the pool's Swap events.
 * - Clanker V3 (WETH-paired): returns `undefined`; we don't price WETH in USDC here.
 *
 * Bump `refreshKey` to repoll (the inline trade panel does this after a swap).
 *
 * React-Query-backed: dedupes the chunked scan across consumers that render
 * the same token/mode/pool tuple (audit ARCH-007).
 */
export interface VolumeState {
  /** USDC volume in raw 6-dec units, or undefined while loading / unsupported. */
  volume: bigint | undefined;
  /** Cumulative token-side volume in raw 18-dec units. */
  volumeToken: bigint | undefined;
  /** True until the first scan completes (or errors). */
  isLoading: boolean;
}

interface VolumeData {
  volume: bigint | undefined;
  volumeToken: bigint | undefined;
}

const STALE_MS = 60_000;

export function useLaunchpadVolume(args: {
  token: Address | undefined;
  mode: number | undefined;
  pool?: Address | undefined;
  refreshKey?: number;
  /** Launchpad that actually holds this (curve) token. Defaults to the live
   *  launchpad; pass the resolved per-generation address for older tokens so
   *  the Buy/Sell volume scan hits the right contract (pages audit 2026-07-02:
   *  prior-generation curve tokens read volume 0 / "-"). */
  launchpad?: Address;
}): VolumeState {
  const { token, mode, pool } = args;
  const lp = args.launchpad ?? ADDRESSES.launchpad;
  // refreshKey deliberately ignored: live trades arrive via WS to the trade
  // panel which already calls queryClient.setQueryData, so bumping
  // refreshKey here would force a full 200k-block re-scan per trade.
  void args.refreshKey;
  const publicClient = usePublicClient();

  const { data, isLoading, isFetching } = useQuery<VolumeData>({
    queryKey: [
      "arcade",
      "launchpad-volume",
      token?.toLowerCase() ?? null,
      mode ?? null,
      pool?.toLowerCase() ?? null,
      lp.toLowerCase(),
    ],
    enabled: !!publicClient && !!token && mode !== undefined,
    staleTime: STALE_MS,
    gcTime: STALE_MS * 5,
    queryFn: async () => {
      if (!publicClient || !token || mode === undefined) {
        return { volume: undefined, volumeToken: undefined };
      }
      try {
        const latest = await publicClient.getBlockNumber();
        if (mode === 2) {
          if (!pool || pool.toLowerCase() === "0x0000000000000000000000000000000000000000") {
            return { volume: 0n, volumeToken: undefined };
          }
          const [t0Raw, t1Raw] = await Promise.all([
            publicClient.readContract({
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
            }),
            publicClient.readContract({
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
            }),
          ]);
          const t0 = (t0Raw as Address).toLowerCase();
          const t1 = (t1Raw as Address).toLowerCase();
          const usdcLc = ADDRESSES.usdc.toLowerCase();
          const usdcIsToken0 = t0 === usdcLc;
          const usdcIsToken1 = t1 === usdcLc;
          if (!usdcIsToken0 && !usdcIsToken1) {
            // WETH-paired (or other non-USDC) pool. We don't price the
            // non-USDC side here; surface volume as undefined so the row
            // shows "-" instead of misreporting WETH amount as USDC.
            return { volume: undefined, volumeToken: undefined };
          }
          const swaps = await scanLogsChunked(
            publicClient,
            { address: pool, event: V3_SWAP_EVT },
            latest,
            { chunk: CHUNK_SMALL, maxBack: MAX_BACK_TRADES, label: "v3.Swap" },
          );
          let sumUsdc = 0n;
          let sumTok = 0n;
          for (const log of swaps) {
            const a0 = log.args.amount0 as bigint;
            const a1 = log.args.amount1 as bigint;
            const usdcRaw = usdcIsToken0 ? a0 : a1;
            const tokRaw = usdcIsToken0 ? a1 : a0;
            sumUsdc += usdcRaw < 0n ? -usdcRaw : usdcRaw;
            sumTok += tokRaw < 0n ? -tokRaw : tokRaw;
          }
          return { volume: sumUsdc, volumeToken: sumTok };
        }
        // PUMP / Arcade. Use indexed-arg filter so the RPC returns only this
        // token's events.
        const [buys, sells] = await Promise.all([
          scanLogsChunked(
            publicClient,
            { address: lp, event: BUY_EVT, args: { token } },
            latest,
            { chunk: CHUNK_SMALL, maxBack: MAX_BACK_TRADES, label: "lp.Buy" },
          ),
          scanLogsChunked(
            publicClient,
            { address: lp, event: SELL_EVT, args: { token } },
            latest,
            { chunk: CHUNK_SMALL, maxBack: MAX_BACK_TRADES, label: "lp.Sell" },
          ),
        ]);
        let sumUsdc = 0n;
        let sumTok = 0n;
        for (const log of buys) {
          sumUsdc += log.args.usdcIn as bigint;
          sumTok += log.args.tokensOut as bigint;
        }
        for (const log of sells) {
          sumUsdc += log.args.usdcOut as bigint;
          sumTok += log.args.tokensIn as bigint;
        }
        return { volume: sumUsdc, volumeToken: sumTok };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[volume] top-level error:", err);
        return { volume: undefined, volumeToken: undefined };
      }
    },
  });

  return {
    volume: data?.volume,
    volumeToken: data?.volumeToken,
    isLoading:
      !!token && mode !== undefined && (isLoading || isFetching),
  };
}
