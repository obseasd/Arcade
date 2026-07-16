/**
 * Canonical OHLC bucketize for Arcade charts. This is the SAME logic as
 * useTokenCandles' inline bucketize (and the indexer/subgraph price parity),
 * factored out so the TradingView datafeed and the lightweight-charts hook can
 * share ONE implementation. Any change here must keep the two chart paths in
 * lockstep.
 */

export type Timeframe = "1s" | "1m" | "5m" | "1h" | "1d";

export const BUCKET_SIZE: Record<Timeframe, number> = {
    "1s": 1,
    "1m": 60,
    "5m": 5 * 60,
    "1h": 60 * 60,
    "1d": 24 * 60 * 60,
};

export interface Candle {
    time: number; // unix seconds (bucket start)
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number; // USDC (human units)
}

export interface OhlcTrade {
    time: number; // unix seconds
    price: number;
    volumeUsdc: number;
    isBuy?: boolean;
}

/**
 * Aggregate trades into OHLC candles. prevClose chaining (so single-trade
 * buckets render a body, not a flat doji) + a side-change candle break (a
 * buy+sell in the same bucket render as two correctly-coloured candles).
 * Verbatim from useTokenCandles.bucketize.
 */
export function bucketize(
    trades: OhlcTrade[],
    bucketSize: number,
    initialPrice?: number,
): Candle[] {
    if (trades.length === 0) return [];
    const candles: Candle[] = [];
    let currentBucket = Math.floor(trades[0].time / bucketSize) * bucketSize;
    let currentCandle: Candle | null = null;
    let currentSide: boolean | undefined = undefined;
    let prevClose: number | null = initialPrice ?? null;

    for (const t of trades) {
        const bucket = Math.floor(t.time / bucketSize) * bucketSize;
        const sideChanged =
            t.isBuy !== undefined &&
            currentSide !== undefined &&
            t.isBuy !== currentSide;
        if (currentCandle === null || bucket !== currentBucket || sideChanged) {
            if (currentCandle !== null) {
                candles.push(currentCandle);
                prevClose = currentCandle.close;
            }
            currentBucket = bucket;
            currentSide = t.isBuy;
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

/** Map a TradingView resolution ("1","5","60","1D","1S"...) to bucket seconds. */
export function resolutionToSeconds(resolution: string): number {
    const r = resolution.toUpperCase();
    if (r.endsWith("S")) return Math.max(1, parseInt(r, 10) || 1); // seconds
    if (r.endsWith("D")) return (parseInt(r, 10) || 1) * 86400; // days
    if (r.endsWith("W")) return (parseInt(r, 10) || 1) * 7 * 86400; // weeks
    if (r.endsWith("M")) return (parseInt(r, 10) || 1) * 30 * 86400; // months (approx)
    return (parseInt(r, 10) || 1) * 60; // minutes (default)
}
