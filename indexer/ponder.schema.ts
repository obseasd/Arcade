import { onchainTable, index } from "ponder";

/**
 * Indexer schema. Two tables:
 *
 *   trade  -- one row per on-chain trade (launchpad Buy/Sell OR V3 pool Swap),
 *             with the USDC-per-token price already derived (same math as the
 *             client's useTokenCandles). The /candles API buckets these into
 *             OHLC. Storing raw trades (not pre-bucketed candles) keeps the API
 *             able to serve ANY timeframe from one dataset.
 *
 *   pool   -- USDC-paired V3 pools discovered from the factory's PoolCreated,
 *             so the Swap handler knows the token0 orientation (usdcIsToken0)
 *             and which non-USDC token the pool prices.
 */

export const trade = onchainTable(
    "trade",
    (t) => ({
        // `${txHash}-${logIndex}` -- unique per log, idempotent on reorg replay.
        id: t.text().primaryKey(),
        // The token being priced (the non-USDC side).
        token: t.hex().notNull(),
        // 'curve' (launchpad Buy/Sell) | 'v3' (pool Swap).
        source: t.text().notNull(),
        // The V3 pool, when source='v3' (null for curve).
        pool: t.hex(),
        // USDC per whole token (human units), already scaled.
        price: t.doublePrecision().notNull(),
        // USDC volume of the trade (human units).
        volumeUsdc: t.doublePrecision().notNull(),
        // True = USDC -> token (buy). Drives the candle side-break.
        isBuy: t.boolean().notNull(),
        // Block timestamp (unix seconds) -- REAL, not estimated like the client.
        blockTime: t.integer().notNull(),
        blockNumber: t.bigint().notNull(),
    }),
    (table) => ({
        // The hot query: all trades for a token, oldest-first, for bucketizing.
        byToken: index().on(table.token, table.blockTime),
    }),
);

export const pool = onchainTable("pool", (t) => ({
    // The pool address.
    id: t.hex().primaryKey(),
    token0: t.hex().notNull(),
    token1: t.hex().notNull(),
    // The non-USDC side (the token this pool prices).
    token: t.hex().notNull(),
    // True when USDC is token0 (selects the sqrtPrice inversion).
    usdcIsToken0: t.boolean().notNull(),
}));
