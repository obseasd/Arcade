/**
 * Price + OHLC math for the Arcade indexer.
 *
 * PORTED VERBATIM from web/lib/hooks/useTokenCandles.ts so the indexer-served
 * candles are byte-for-byte the same shape the client-side RPC scan produced --
 * only with complete history, real block timestamps, and no 500-trade cap.
 * Any change here MUST be mirrored in useTokenCandles (and vice-versa) or the
 * chart will visibly jump when a token crosses the fallback boundary.
 *
 * This module is PURE (no ponder/viem/chain imports) so it is unit-testable in
 * isolation and can be imported by both the indexer handlers and its API.
 */

const Q192 = 2n ** 192n;

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

export interface Trade {
    time: number; // unix seconds
    price: number; // USDC per whole token
    volumeUsdc: number; // human USDC
    isBuy?: boolean;
}

/**
 * Curve/launchpad price. `newPriceQ64` is USDC-per-whole-token in Q64 fixed
 * point at RAW units (6-dec USDC / 18-dec token), so the *1e12 scale lifts it
 * to human USDC-per-whole-token. Mirrors useTokenCandles onCurveLog / fetchTrades.
 */
export function priceFromNewPriceQ64(priceQ64: bigint): number {
    const priceE24 = (priceQ64 * 10n ** 24n) >> 64n;
    return (Number(priceE24) / 1e24) * 1e12;
}

/**
 * V3 pool price from sqrtPriceX96. `usdcIsToken0` selects the inversion.
 * Mirrors useTokenCandles priceFromSqrtX96 exactly.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint, usdcIsToken0: boolean): number {
    const num = sqrtPriceX96 * sqrtPriceX96;
    let ratioE24: bigint;
    if (usdcIsToken0) {
        ratioE24 = (Q192 * 10n ** 24n) / num;
    } else {
        ratioE24 = (num * 10n ** 24n) / Q192;
    }
    return Number(ratioE24) / 1e12;
}

/** USDC volume (human) from a curve buy/sell raw USDC amount (6 dec). */
export function usdcVolumeFromRaw(raw: bigint): number {
    const abs = raw < 0n ? -raw : raw;
    return Number(abs) / 1e6;
}

/**
 * Aggregate trades into OHLC candles. PORTED VERBATIM from useTokenCandles
 * bucketize: prevClose chaining + side-change candle breaks so a buy+sell in
 * the same bucket render as two correctly-coloured candles.
 */
export function bucketize(
    trades: Trade[],
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
