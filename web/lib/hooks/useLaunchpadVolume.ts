"use client";

import { useEffect, useState } from "react";
import { Address, parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/constants";

const BUY_EVT = parseAbiItem(
  "event Buy(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 newPriceQ64)",
);
const SELL_EVT = parseAbiItem(
  "event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 newPriceQ64)",
);
const V3_SWAP_EVT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

/** Per-call block window. thirdweb's Arc RPC is finicky on log queries — 1000
 * blocks per call works reliably. */
const CHUNK = 1_000n;
/** How far back we walk total. 200k blocks ≈ 2-3 days on a 1s-block chain. */
const MAX_BACK = 200_000n;

async function getLogsChunked(
  publicClient: any,
  params: { address: Address; event: any; args?: Record<string, unknown> },
  latest: bigint,
  label: string,
): Promise<any[]> {
  const all: any[] = [];
  let end = latest;
  let walked = 0n;
  let errors = 0;
  while (walked < MAX_BACK) {
    const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
    try {
      const logs = await publicClient.getLogs({
        ...params,
        fromBlock: start,
        toBlock: end,
      });
      all.push(...logs);
    } catch (err) {
      errors += 1;
      if (errors > 3) {
        // eslint-disable-next-line no-console
        console.warn(`[volume] ${label} getLogs failed (${errors} times), stopping. last err:`, err);
        break;
      }
    }
    if (start === 0n) break;
    walked += end - start + 1n;
    end = start - 1n;
  }
  return all;
}

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
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!publicClient || !token || mode === undefined) {
      setVol(undefined);
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
          const swaps = await getLogsChunked(
            publicClient,
            { address: pool, event: V3_SWAP_EVT },
            latest,
            "v3.Swap",
          );
          let sum = 0n;
          for (const log of swaps) {
            const a0 = log.args.amount0 as bigint;
            const a1 = log.args.amount1 as bigint;
            const usdcRaw = usdcIsToken0 ? a0 : a1;
            const abs = usdcRaw < 0n ? -usdcRaw : usdcRaw;
            sum += abs;
          }
          if (!cancelled) setVol(sum);
        } else {
          // PUMP / Arcade. Use indexed-arg filter so the RPC returns only this
          // token's events (smaller payload, less likely to time out).
          const [buys, sells] = await Promise.all([
            getLogsChunked(
              publicClient,
              { address: ADDRESSES.launchpad, event: BUY_EVT, args: { token } },
              latest,
              "lp.Buy",
            ),
            getLogsChunked(
              publicClient,
              { address: ADDRESSES.launchpad, event: SELL_EVT, args: { token } },
              latest,
              "lp.Sell",
            ),
          ]);
          let sum = 0n;
          for (const log of buys) sum += log.args.usdcIn as bigint;
          for (const log of sells) sum += log.args.usdcOut as bigint;
          if (!cancelled) setVol(sum);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[volume] top-level error:", err);
        if (!cancelled) setVol(undefined);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token, mode, pool, refreshKey]);

  return { volume: vol, isLoading };
}
