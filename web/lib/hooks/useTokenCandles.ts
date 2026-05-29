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

// Wider chunks = fewer RPC round-trips. 10k blocks per call is well below the
// per-tx ceiling of the official Arc RPC. We also stop early once we've walked
// 100k blocks (~28h at 1s/block) which covers the relevant history for any
// young token; the rest can be backfilled later by a backend indexer.
const CHUNK = 10_000n;
const MAX_BACK = 100_000n;
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

/** Module-level cache so flipping between timeframes reuses the trade scan. */
const tradesCache = new Map<string, { trades: Trade[]; cachedAt: number }>();
const CACHE_TTL_MS = 30_000; // 30s

/**
 * Reads on-chain trade events for a token, computes the implied USDC-per-token
 * price for each trade, and aggregates into OHLC candles.
 *
 * - PUMP / Arcade: reads launchpad Buy + Sell events, uses `newPriceQ64` as price
 * - Clanker V3 (USDC-paired): reads pool Swap events, derives price from `sqrtPriceX96`
 * - Clanker V3 (WETH-paired): returns empty (no USDC price reference)
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
  const [candles, setCandles] = useState<Candle[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!publicClient || !token || mode === undefined) {
      setCandles([]);
      return;
    }
    let cancelled = false;
    const cacheKey = `${token.toLowerCase()}|${mode}|${(pool ?? "").toLowerCase()}`;
    const cached = tradesCache.get(cacheKey);
    const isFresh = cached && Date.now() - cached.cachedAt < CACHE_TTL_MS;
    if (isFresh) {
      // Re-bucket the cached trades for the new timeframe; no RPC needed.
      setCandles(bucketize(cached!.trades, BUCKET_SIZE[timeframe]));
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    (async () => {
      try {
        const trades = await fetchTrades(publicClient, token, mode, pool);
        if (cancelled) return;
        tradesCache.set(cacheKey, { trades, cachedAt: Date.now() });
        const buckets = bucketize(trades, BUCKET_SIZE[timeframe]);
        setCandles(buckets);
      } catch {
        if (!cancelled) setCandles([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token, mode, pool, timeframe, refreshKey]);

  return { candles, isLoading };
}

async function fetchTrades(
  publicClient: any,
  token: Address,
  mode: number,
  pool?: Address,
): Promise<Trade[]> {
  // Skip per-block getBlock calls: that would be O(N events) round trips and
  // is the dominant cost. Arc averages ~1s blocks, so we estimate timestamp
  // from latest block: t ≈ latestTs - (latestBlock - blockNumber).
  const latestBlock = await publicClient.getBlock();
  const latestTs = Number(latestBlock.timestamp);
  const latestN = latestBlock.number as bigint;
  const tsFor = (bn: bigint) => latestTs - Number(latestN - bn);

  if (mode === 2) {
    // Clanker V3
    if (!pool || pool === "0x0000000000000000000000000000000000000000") return [];
    const t0 = (await publicClient.readContract({
      address: pool,
      abi: [
        { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
      ],
      functionName: "token0",
    })) as Address;
    const usdcIsToken0 = t0.toLowerCase() === ADDRESSES.usdc.toLowerCase();
    if (!usdcIsToken0 && t0.toLowerCase() !== token.toLowerCase()) {
      return [];
    }
    const swaps = await getLogsChunked(
      publicClient,
      { address: pool, event: V3_SWAP_EVT },
      latestN,
    );
    const trades: Trade[] = [];
    for (const log of swaps) {
      const sqrtPriceX96 = log.args.sqrtPriceX96 as bigint;
      if (!sqrtPriceX96) continue;
      const num = sqrtPriceX96 * sqrtPriceX96;
      // Scale by 10^18 in BigInt first to preserve precision (otherwise BigInt
      // integer division of a small ratio truncates to 0). Then convert to
      // Number and apply the 6/18 decimals adjustment in one step.
      //   ratio_raw = USDC_raw / token_raw
      //   USDC per whole token = ratio_raw * 10^12
      //   ratioE18 = ratio_raw * 10^18 → price = Number(ratioE18) / 10^6
      let ratioE18: bigint;
      if (usdcIsToken0) {
        ratioE18 = (Q192 * 10n ** 18n) / num;
      } else {
        ratioE18 = (num * 10n ** 18n) / Q192;
      }
      const price = Number(ratioE18) / 1e6;
      const a0 = log.args.amount0 as bigint;
      const a1 = log.args.amount1 as bigint;
      const usdcRaw = usdcIsToken0 ? a0 : a1;
      const usdcAbs = usdcRaw < 0n ? -usdcRaw : usdcRaw;
      const volumeUsdc = Number(usdcAbs) / 1e6;
      trades.push({ time: tsFor(log.blockNumber as bigint), price, volumeUsdc });
    }
    trades.sort((a, b) => a.time - b.time);
    return trades;
  }

  // PUMP / Arcade. `newPriceQ64` is USDC-per-whole-token × 2^64.
  const [buys, sells] = await Promise.all([
    getLogsChunked(
      publicClient,
      { address: ADDRESSES.launchpad, event: BUY_EVT, args: { token } },
      latestN,
    ),
    getLogsChunked(
      publicClient,
      { address: ADDRESSES.launchpad, event: SELL_EVT, args: { token } },
      latestN,
    ),
  ]);
  const allLogs = [...buys, ...sells];
  const trades: Trade[] = [];
  for (const log of allLogs) {
    const priceQ64 = log.args.newPriceQ64 as bigint | undefined;
    if (!priceQ64) continue;
    // price = priceQ64 / 2^64, computed with extra precision:
    // priceE18 = priceQ64 * 10^18 / 2^64; then Number(priceE18) / 10^18.
    const priceE18 = (priceQ64 * 10n ** 18n) >> 64n;
    const price = Number(priceE18) / 1e18;
    const isBuy = "usdcIn" in (log.args as any);
    const volumeUsdc = Number(isBuy ? log.args.usdcIn : log.args.usdcOut) / 1e6;
    trades.push({ time: tsFor(log.blockNumber as bigint), price, volumeUsdc });
  }
  trades.sort((a, b) => a.time - b.time);
  return trades;
}

async function getLogsChunked(
  publicClient: any,
  params: { address: Address; event: any; args?: Record<string, unknown> },
  latest: bigint,
): Promise<any[]> {
  const all: any[] = [];
  let end = latest;
  let walked = 0n;
  while (walked < MAX_BACK) {
    const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
    try {
      const logs = await publicClient.getLogs({
        ...params,
        fromBlock: start,
        toBlock: end,
      });
      all.push(...logs);
    } catch {
      // If wide chunk fails on this RPC, fall back to narrower windows so the
      // scan still progresses for the older history.
      if (CHUNK > 1_000n) break;
    }
    if (start === 0n) break;
    if (all.length >= EARLY_EXIT_TRADES) break;
    walked += end - start + 1n;
    end = start - 1n;
  }
  return all;
}

function bucketize(trades: Trade[], bucketSize: number): Candle[] {
  if (trades.length === 0) return [];
  const candles: Candle[] = [];
  let currentBucket = Math.floor(trades[0].time / bucketSize) * bucketSize;
  let currentCandle: Candle | null = null;
  // Track the close of the previous candle so the next candle's `open` chains
  // onto it. Without chaining, every bucket would have `open == close` for
  // single-trade buckets and the chart shows flat dojis instead of colored
  // bodies that move with the price.
  let prevClose: number | null = null;

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
