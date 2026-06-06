"use client";

import { useEffect, useState } from "react";
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
 * - Clanker V3 (WETH-paired): returns `undefined` — we don't price WETH in USDC here.
 *
 * Bump `refreshKey` to repoll (the inline trade panel does this after a swap).
 */
export interface VolumeState {
  /** USDC volume in raw 6-dec units, or undefined while loading / unsupported. */
  volume: bigint | undefined;
  /** Cumulative token-side volume in raw 18-dec units. */
  volumeToken: bigint | undefined;
  /** True until the first scan completes (or errors). */
  isLoading: boolean;
}

export function useLaunchpadVolume(args: {
  token: Address | undefined;
  mode: number | undefined;
  pool?: Address | undefined;
  refreshKey?: number;
}): VolumeState {
  const { token, mode, pool, refreshKey } = args;
  const publicClient = usePublicClient();
  const [vol, setVol] = useState<bigint | undefined>(undefined);
  const [volTok, setVolTok] = useState<bigint | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!publicClient || !token || mode === undefined) {
      setVol(undefined);
      setVolTok(undefined);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        if (mode === 2) {
          if (!pool || pool === "0x0000000000000000000000000000000000000000") {
            if (!cancelled) setVol(0n);
            return;
          }
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
          const t0 = (t0Raw as Address).toLowerCase();
          const usdcLc = ADDRESSES.usdc.toLowerCase();
          const usdcIsToken0 = t0 === usdcLc;
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
          if (!cancelled) {
            setVol(sumUsdc);
            setVolTok(sumTok);
          }
        } else {
          // PUMP / Arcade. Use indexed-arg filter so the RPC returns only this
          // token's events (smaller payload, less likely to time out).
          const [buys, sells] = await Promise.all([
            scanLogsChunked(
              publicClient,
              { address: ADDRESSES.launchpad, event: BUY_EVT, args: { token } },
              latest,
              { chunk: CHUNK_SMALL, maxBack: MAX_BACK_TRADES, label: "lp.Buy" },
            ),
            scanLogsChunked(
              publicClient,
              { address: ADDRESSES.launchpad, event: SELL_EVT, args: { token } },
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
          if (!cancelled) {
            setVol(sumUsdc);
            setVolTok(sumTok);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[volume] top-level error:", err);
        if (!cancelled) {
          setVol(undefined);
          setVolTok(undefined);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token, mode, pool, refreshKey]);

  return { volume: vol, volumeToken: volTok, isLoading };
}
