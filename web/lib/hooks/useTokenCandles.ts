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

const CHUNK = 1_000n;
const MAX_BACK = 500_000n;
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

export type Timeframe = "5m" | "1h" | "1d";

const BUCKET_SIZE: Record<Timeframe, number> = {
  "5m": 5 * 60,
  "1h": 60 * 60,
  "1d": 24 * 60 * 60,
};

interface Trade {
  time: number;
  price: number;
  volumeUsdc: number;
}

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
    setIsLoading(true);
    (async () => {
      try {
        const trades = await fetchTrades(publicClient, token, mode, pool);
        if (cancelled) return;
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
  const latest = await publicClient.getBlockNumber();

  if (mode === 2) {
    // Clanker V3
    if (!pool || pool === "0x0000000000000000000000000000000000000000") return [];
    // Need to know which side is USDC to compute price properly
    const t0 = (await publicClient.readContract({
      address: pool,
      abi: [
        { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
      ],
      functionName: "token0",
    })) as Address;
    const usdcIsToken0 = t0.toLowerCase() === ADDRESSES.usdc.toLowerCase();
    if (!usdcIsToken0 && t0.toLowerCase() !== token.toLowerCase()) {
      // Neither side is USDC; we don't price WETH-paired pools here.
      return [];
    }
    const swaps = await getLogsChunked(
      publicClient,
      { address: pool, event: V3_SWAP_EVT },
      latest,
    );
    const blockTimes = await fetchBlockTimes(
      publicClient,
      swaps.map((s: any) => s.blockNumber as bigint),
    );
    const trades: Trade[] = [];
    for (const log of swaps) {
      const sqrtPriceX96 = log.args.sqrtPriceX96 as bigint;
      if (!sqrtPriceX96) continue;
      // price (token1 per token0) = sqrtPriceX96^2 / 2^192
      // We want USDC per token, accounting for decimals (USDC 6, token 18).
      const num = sqrtPriceX96 * sqrtPriceX96;
      let priceRaw: bigint;
      if (usdcIsToken0) {
        // 1 token1 raw = Q192 / num token0 raw → USDC per token: scale 1e18/1e6 = 1e12
        priceRaw = (Q192 * 1_000_000_000_000n) / num;
      } else {
        // 1 token0 raw = num/Q192 token1 raw → USDC per token: scale 1e18/1e6 = 1e12
        priceRaw = (num * 1_000_000_000_000n) / Q192;
      }
      const price = Number(priceRaw) / 1e12; // USDC per whole token, ~scaled
      const a0 = log.args.amount0 as bigint;
      const a1 = log.args.amount1 as bigint;
      const usdcAbs = (usdcIsToken0 ? a0 : a1) < 0n ? -(usdcIsToken0 ? a0 : a1) : (usdcIsToken0 ? a0 : a1);
      const volumeUsdc = Number(usdcAbs) / 1e6;
      const t = blockTimes.get(log.blockNumber as bigint) ?? 0;
      trades.push({ time: t, price, volumeUsdc });
    }
    trades.sort((a, b) => a.time - b.time);
    return trades;
  }

  // PUMP / Arcade
  const [buys, sells] = await Promise.all([
    getLogsChunked(
      publicClient,
      { address: ADDRESSES.launchpad, event: BUY_EVT, args: { token } },
      latest,
    ),
    getLogsChunked(
      publicClient,
      { address: ADDRESSES.launchpad, event: SELL_EVT, args: { token } },
      latest,
    ),
  ]);
  const allLogs = [...buys, ...sells];
  const blockTimes = await fetchBlockTimes(
    publicClient,
    allLogs.map((l: any) => l.blockNumber as bigint),
  );
  const trades: Trade[] = [];
  for (const log of allLogs) {
    const priceQ64 = log.args.newPriceQ64 as bigint | undefined;
    if (!priceQ64) continue;
    // Q64.64 USDC_raw per token_raw → USDC per token = priceQ64 * 1e12 / 2^64
    const num = priceQ64 * 1_000_000_000_000n;
    const denom = 1n << 64n;
    const price = Number(num / denom) / 1e6 + (Number(num % denom) / Number(denom)) / 1e6;
    const isBuy = "usdcIn" in (log.args as any);
    const volumeUsdc = Number(isBuy ? log.args.usdcIn : log.args.usdcOut) / 1e6;
    const t = blockTimes.get(log.blockNumber as bigint) ?? 0;
    trades.push({ time: t, price, volumeUsdc });
  }
  trades.sort((a, b) => a.time - b.time);
  return trades;
}

async function fetchBlockTimes(
  publicClient: any,
  blockNumbers: bigint[],
): Promise<Map<bigint, number>> {
  const unique = Array.from(new Set(blockNumbers.map((b) => b.toString()))).map((s) => BigInt(s));
  const blocks = await Promise.all(
    unique.map((bn) => publicClient.getBlock({ blockNumber: bn }).catch(() => null)),
  );
  const map = new Map<bigint, number>();
  for (let i = 0; i < unique.length; i++) {
    const b = blocks[i];
    if (b) map.set(unique[i], Number(b.timestamp));
  }
  return map;
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
      break;
    }
    if (start === 0n) break;
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

  for (const t of trades) {
    const bucket = Math.floor(t.time / bucketSize) * bucketSize;
    if (currentCandle === null || bucket !== currentBucket) {
      if (currentCandle !== null) candles.push(currentCandle);
      currentBucket = bucket;
      currentCandle = {
        time: bucket,
        open: t.price,
        high: t.price,
        low: t.price,
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
