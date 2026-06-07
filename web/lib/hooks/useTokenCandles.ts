"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Address } from "viem";
import { usePublicClient, useReadContract } from "wagmi";
import { ADDRESSES } from "@/lib/constants";
import { BUY_EVT, SELL_EVT, V3_SWAP_EVT } from "@/lib/eventSignatures";
import { CHUNK_LARGE, MAX_BACK_CANDLES, scanLogsChunked } from "@/lib/eventScan";
import { useWatchEvent } from "./useWatchEvent";

const EARLY_EXIT_TRADES = 500;
const Q192 = 2n ** 192n;

export interface Candle {
  /** Unix timestamp in seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** USDC volume in raw 6-dec units (formatted as Number for display). */
  volume: number;
}

export type Timeframe = "1s" | "1m" | "5m" | "1h" | "1d";

const BUCKET_SIZE: Record<Timeframe, number> = {
  "1s": 1,
  "1m": 60,
  "5m": 5 * 60,
  "1h": 60 * 60,
  "1d": 24 * 60 * 60,
};

interface Trade {
  time: number;
  price: number;
  volumeUsdc: number;
}

interface FetchResult {
  trades: Trade[];
  /** Pre-trade pool / curve price. Used as the OPEN of the first candle so it
   *  shows a meaningful body instead of a flat doji. */
  initialPrice?: number;
}

const SCAN_STALE_MS = 30_000;

/**
 * Reads on-chain trade events for a token, computes the implied USDC-per-token
 * price for each trade, and aggregates into OHLC candles.
 *
 * - PUMP / Arcade: reads launchpad Buy + Sell events, uses `newPriceQ64` as price
 * - Clanker V3 (USDC-paired): reads pool Swap events, derives price from `sqrtPriceX96`
 * - Clanker V3 (WETH-paired): returns empty (no USDC price reference)
 *
 * React-Query-backed. Live WS pushes mutate the cached trade array directly
 * via setQueryData; flipping timeframes only re-buckets in useMemo without
 * re-running the chunked scan (audit ARCH-007).
 */
export function useTokenCandles(args: {
  token: Address | undefined;
  mode: number | undefined;
  pool?: Address | undefined;
  timeframe: Timeframe;
  refreshKey?: number;
}): { candles: Candle[]; isLoading: boolean } {
  const { token, mode, pool, timeframe, refreshKey } = args;
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const tradesKey = useMemo(
    () => [
      "arcade",
      "token-trades-candles",
      token?.toLowerCase() ?? null,
      mode ?? null,
      pool?.toLowerCase() ?? null,
      refreshKey ?? 0,
    ],
    [token, mode, pool, refreshKey],
  );

  const { data, isLoading, isFetching } = useQuery<FetchResult>({
    queryKey: tradesKey,
    enabled: !!publicClient && !!token && mode !== undefined,
    staleTime: SCAN_STALE_MS,
    gcTime: SCAN_STALE_MS * 5,
    queryFn: async () => {
      if (!publicClient || !token || mode === undefined) return { trades: [] };
      return fetchTrades(publicClient, token, mode, pool);
    },
  });

  // Block anchor for WS event timestamping. One-shot read at mount, refreshed
  // every 5 minutes. Cheap; useReadContract would be overkill so we use a
  // plain useQuery on getBlock.
  const { data: tsAnchor } = useQuery<{ ts: number; n: bigint } | null>({
    queryKey: ["arcade", "block-anchor"],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      if (!publicClient) return null;
      try {
        const b: any = await publicClient.getBlock();
        return { ts: Number(b.timestamp), n: b.number as bigint };
      } catch {
        return null;
      }
    },
  });

  // V3 pool token0 lookup. The hook used to do this in a useEffect that wrote
  // local state; useReadContract gives us the same answer via wagmi's RQ
  // backing and stays cached across components reading the same pool.
  const t0Query = useReadContract({
    address: pool && pool !== "0x0000000000000000000000000000000000000000"
      ? pool
      : undefined,
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
    query: {
      enabled:
        mode === 2 && !!pool && pool !== "0x0000000000000000000000000000000000000000",
      staleTime: Infinity,
    },
  });
  const usdcIsToken0 =
    mode === 2 && t0Query.data
      ? (t0Query.data as string).toLowerCase() === ADDRESSES.usdc.toLowerCase()
      : null;

  // Helper: append fresh trades to the cached scan result. Used by all three
  // WS subscriptions. The merge dedupes by (time, price, volume) so an
  // overlapping backup fetch doesn't double-count.
  const appendTrades = useCallback(
    (newTrades: Trade[]) => {
      if (newTrades.length === 0) return;
      queryClient.setQueryData<FetchResult | undefined>(tradesKey, (prev) => {
        const base = prev ?? { trades: [] };
        const merged = [...base.trades, ...newTrades]
          .filter(
            (t, i, arr) =>
              arr.findIndex(
                (x) =>
                  x.time === t.time &&
                  x.price === t.price &&
                  x.volumeUsdc === t.volumeUsdc,
              ) === i,
          )
          .sort((a, b) => a.time - b.time);
        return { ...base, trades: merged };
      });
    },
    [queryClient, tradesKey],
  );

  const tsForBlock = useCallback(
    (bn: bigint) =>
      tsAnchor
        ? tsAnchor.ts - Number(tsAnchor.n - bn)
        : Math.floor(Date.now() / 1000),
    [tsAnchor],
  );

  const onSwapLog = useCallback(
    (logs: any[]) => {
      // Wait for the cached token0 lookup to land before we trust ANY
      // direction-derived value. Skipping a few logs at startup beats
      // pushing inverted prices that whiplash the chart.
      if (mode !== 2 || !pool || usdcIsToken0 === null) return;
      const parsed: Trade[] = [];
      for (const log of logs) {
        const sqrtPriceX96 = log.args?.sqrtPriceX96 as bigint | undefined;
        if (!sqrtPriceX96) continue;
        const price = priceFromSqrtX96(sqrtPriceX96, usdcIsToken0);
        const a0 = log.args.amount0 as bigint;
        const a1 = log.args.amount1 as bigint;
        const usdcRaw = usdcIsToken0 ? a0 : a1;
        const usdcAbs = usdcRaw < 0n ? -usdcRaw : usdcRaw;
        parsed.push({
          time: tsForBlock(log.blockNumber as bigint),
          price,
          volumeUsdc: Number(usdcAbs) / 1e6,
        });
      }
      appendTrades(parsed);
    },
    [mode, pool, tsForBlock, appendTrades, usdcIsToken0],
  );

  const onCurveLog = useCallback(
    (logs: any[]) => {
      const parsed: Trade[] = [];
      for (const log of logs) {
        const priceQ64 = log.args?.newPriceQ64 as bigint | undefined;
        if (!priceQ64) continue;
        const priceE24 = (priceQ64 * 10n ** 24n) >> 64n;
        const price = Number(priceE24) / 1e24;
        const isBuy = "usdcIn" in (log.args as any);
        const volumeUsdc =
          Number(isBuy ? log.args.usdcIn : log.args.usdcOut) / 1e6;
        parsed.push({
          time: tsForBlock(log.blockNumber as bigint),
          price,
          volumeUsdc,
        });
      }
      appendTrades(parsed);
    },
    [tsForBlock, appendTrades],
  );

  useWatchEvent({
    address: mode === 2 ? pool : undefined,
    event: V3_SWAP_EVT,
    enabled: mode === 2 && !!pool,
    onLogs: onSwapLog,
  });
  useWatchEvent({
    address: mode !== undefined && mode !== 2 ? ADDRESSES.launchpad : undefined,
    event: BUY_EVT,
    args: token ? { token } : undefined,
    enabled: mode !== undefined && mode !== 2 && !!token,
    onLogs: onCurveLog,
  });
  useWatchEvent({
    address: mode !== undefined && mode !== 2 ? ADDRESSES.launchpad : undefined,
    event: SELL_EVT,
    args: token ? { token } : undefined,
    enabled: mode !== undefined && mode !== 2 && !!token,
    onLogs: onCurveLog,
  });

  const candles = useMemo<Candle[]>(() => {
    if (!data) return [];
    return bucketize(data.trades, BUCKET_SIZE[timeframe], data.initialPrice);
  }, [data, timeframe]);

  return {
    candles,
    isLoading:
      !!token && mode !== undefined && (isLoading || isFetching),
  };
}

function priceFromSqrtX96(sqrtPriceX96: bigint, usdcIsToken0: boolean): number {
  const num = sqrtPriceX96 * sqrtPriceX96;
  let ratioE24: bigint;
  if (usdcIsToken0) {
    ratioE24 = (Q192 * 10n ** 24n) / num;
  } else {
    ratioE24 = (num * 10n ** 24n) / Q192;
  }
  return Number(ratioE24) / 1e12;
}

async function fetchTrades(
  publicClient: any,
  token: Address,
  mode: number,
  pool?: Address,
): Promise<FetchResult> {
  // Skip per-block getBlock calls: O(N events) round trips otherwise. Arc
  // averages ~1s blocks; we estimate timestamp from latest block:
  // t ≈ latestTs - (latestBlock - blockNumber).
  const latestBlock = await publicClient.getBlock();
  const latestTs = Number(latestBlock.timestamp);
  const latestN = latestBlock.number as bigint;
  const tsFor = (bn: bigint) => latestTs - Number(latestN - bn);

  if (mode === 2) {
    // Clanker V3
    if (!pool || pool === "0x0000000000000000000000000000000000000000") {
      return { trades: [] };
    }
    const t0 = (await publicClient.readContract({
      address: pool,
      abi: [
        {
          type: "function",
          name: "token0",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "address" }],
        },
      ],
      functionName: "token0",
    })) as Address;
    const usdcIsToken0 = t0.toLowerCase() === ADDRESSES.usdc.toLowerCase();
    if (!usdcIsToken0 && t0.toLowerCase() !== token.toLowerCase()) {
      return { trades: [] };
    }
    // We intentionally do NOT use the pool's Initialize event sqrtPriceX96 as
    // the first candle's open. Clanker V3 pools are initialized at the FDV
    // mcap price, but no liquidity actually sits at that tick - all 3
    // single-sided positions are offset by at least tickSpacing above. So
    // the first real swap "teleports" from the init tick to the first liquid
    // tick, which would render as a huge artificial candle body. Leave the
    // first candle as a doji and let subsequent candles chain properly.
    const initialPrice: number | undefined = undefined;
    const swaps = await scanLogsChunked(
      publicClient,
      { address: pool, event: V3_SWAP_EVT },
      latestN,
      { chunk: CHUNK_LARGE, maxBack: MAX_BACK_CANDLES, earlyExit: EARLY_EXIT_TRADES },
    );
    const trades: Trade[] = [];
    for (const log of swaps) {
      const sqrtPriceX96 = log.args.sqrtPriceX96 as bigint;
      if (!sqrtPriceX96) continue;
      const price = priceFromSqrtX96(sqrtPriceX96, usdcIsToken0);
      const a0 = log.args.amount0 as bigint;
      const a1 = log.args.amount1 as bigint;
      const usdcRaw = usdcIsToken0 ? a0 : a1;
      const usdcAbs = usdcRaw < 0n ? -usdcRaw : usdcRaw;
      const volumeUsdc = Number(usdcAbs) / 1e6;
      trades.push({ time: tsFor(log.blockNumber as bigint), price, volumeUsdc });
    }
    trades.sort((a, b) => a.time - b.time);
    return { trades, initialPrice };
  }

  // PUMP / Arcade. `newPriceQ64` is USDC-per-whole-token × 2^64.
  const [buys, sells] = await Promise.all([
    scanLogsChunked(
      publicClient,
      { address: ADDRESSES.launchpad, event: BUY_EVT, args: { token } },
      latestN,
      { chunk: CHUNK_LARGE, maxBack: MAX_BACK_CANDLES, earlyExit: EARLY_EXIT_TRADES },
    ),
    scanLogsChunked(
      publicClient,
      { address: ADDRESSES.launchpad, event: SELL_EVT, args: { token } },
      latestN,
      { chunk: CHUNK_LARGE, maxBack: MAX_BACK_CANDLES, earlyExit: EARLY_EXIT_TRADES },
    ),
  ]);
  const allLogs = [...buys, ...sells];
  const trades: Trade[] = [];
  for (const log of allLogs) {
    const priceQ64 = log.args.newPriceQ64 as bigint | undefined;
    if (!priceQ64) continue;
    const priceE24 = (priceQ64 * 10n ** 24n) >> 64n;
    const price = Number(priceE24) / 1e24;
    const isBuy = "usdcIn" in (log.args as any);
    const volumeUsdc = Number(isBuy ? log.args.usdcIn : log.args.usdcOut) / 1e6;
    trades.push({ time: tsFor(log.blockNumber as bigint), price, volumeUsdc });
  }
  trades.sort((a, b) => a.time - b.time);
  return { trades };
}

function bucketize(trades: Trade[], bucketSize: number, initialPrice?: number): Candle[] {
  if (trades.length === 0) return [];
  const candles: Candle[] = [];
  let currentBucket = Math.floor(trades[0].time / bucketSize) * bucketSize;
  let currentCandle: Candle | null = null;
  // Track the close of the previous candle so the next candle's `open` chains
  // onto it. Without chaining, every bucket would have `open == close` for
  // single-trade buckets and the chart shows flat dojis instead of colored
  // bodies that move with the price.
  let prevClose: number | null = initialPrice ?? null;

  for (const t of trades) {
    const bucket = Math.floor(t.time / bucketSize) * bucketSize;
    if (currentCandle === null || bucket !== currentBucket) {
      if (currentCandle !== null) {
        candles.push(currentCandle);
        prevClose = currentCandle.close;
      }
      currentBucket = bucket;
      const open: number = prevClose ?? t.price;
      currentCandle = {
        time: bucket,
        open,
        high: Math.max(open, t.price),
        low: Math.min(open, t.price),
        close: t.price,
        volume: t.volumeUsdc,
      };
    } else {
      currentCandle.high = Math.max(currentCandle.high, t.price);
      currentCandle.low = Math.min(currentCandle.low, t.price);
      currentCandle.close = t.price;
      currentCandle.volume += t.volumeUsdc;
    }
  }
  if (currentCandle !== null) candles.push(currentCandle);
  return candles;
}
