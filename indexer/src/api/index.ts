import { db } from "ponder:api";
import { trade } from "ponder:schema";
import { Hono } from "hono";
import { asc, eq } from "ponder";
import { bucketize, BUCKET_SIZE, type Trade, type Timeframe } from "../lib/price";

/**
 * Read API for the frontend. GET /candles?token=0x..&tf=1m returns OHLC candles
 * bucketized from the indexed trades -- identical semantics to the client's
 * useTokenCandles, but complete history, real block timestamps, no 500 cap.
 *
 * CORS is open (read-only public price data). The frontend prefers this and
 * falls back to the client RPC scan when the indexer URL is unset or errors.
 */

const app = new Hono();

const TIMEFRAMES = new Set<Timeframe>(["1s", "1m", "5m", "1h", "1d"]);
// Hard ceiling so a single request cannot pull an unbounded row set.
const MAX_TRADES = 50_000;

app.use("*", async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
});

app.get("/candles", async (c) => {
    const token = (c.req.query("token") ?? "").toLowerCase();
    const tf = (c.req.query("tf") ?? "1m") as Timeframe;

    if (!/^0x[0-9a-f]{40}$/.test(token)) {
        return c.json({ error: "token must be a 20-byte hex address" }, 400);
    }
    if (!TIMEFRAMES.has(tf)) {
        return c.json({ error: "tf must be one of 1s,1m,5m,1h,1d" }, 400);
    }

    const rows = await db
        .select({
            time: trade.blockTime,
            price: trade.price,
            volumeUsdc: trade.volumeUsdc,
            isBuy: trade.isBuy,
        })
        .from(trade)
        .where(eq(trade.token, token as `0x${string}`))
        .orderBy(asc(trade.blockTime), asc(trade.blockNumber))
        .limit(MAX_TRADES);

    const trades: Trade[] = rows.map((r) => ({
        time: r.time,
        price: r.price,
        volumeUsdc: r.volumeUsdc,
        isBuy: r.isBuy,
    }));

    const candles = bucketize(trades, BUCKET_SIZE[tf]);
    return c.json({ token, tf, count: candles.length, candles });
});

/**
 * Raw trades for a token, oldest-first. The frontend's useTokenCandles uses
 * this as the HISTORICAL base and keeps its own live-WS append + bucketize, so
 * swapping the client RPC scan for the indexer changes only the data source,
 * not the live behaviour. Returns the same {time, price, volumeUsdc, isBuy}
 * shape the client scan produced.
 */
app.get("/trades", async (c) => {
    const token = (c.req.query("token") ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) {
        return c.json({ error: "token must be a 20-byte hex address" }, 400);
    }
    const rows = await db
        .select({
            time: trade.blockTime,
            price: trade.price,
            volumeUsdc: trade.volumeUsdc,
            isBuy: trade.isBuy,
        })
        .from(trade)
        .where(eq(trade.token, token as `0x${string}`))
        .orderBy(asc(trade.blockTime), asc(trade.blockNumber))
        .limit(MAX_TRADES);
    return c.json({ token, count: rows.length, trades: rows });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
