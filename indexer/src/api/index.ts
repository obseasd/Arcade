import { db } from "ponder:api";
import { trade } from "ponder:schema";
import { Hono } from "hono";
import { and, asc, eq } from "ponder";
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
const SOURCES = new Set(["curve", "v3"]);

/**
 * Optional source filter. The client shows ONE source per token (mode==2 => v3,
 * else curve); the V3 factory is permissionless, so a graduated curve token can
 * ALSO have unrelated USDC/V3 pools. Passing ?source= lets the frontend restrict
 * to exactly what the client would show, avoiding a mixed-source chart. Absent =
 * all sources (full history).
 */
function sourceFilter(
    token: string,
    source: string | undefined,
    pool: string | undefined,
) {
    const conds = [eq(trade.token, token as `0x${string}`)];
    if (source && SOURCES.has(source)) {
        conds.push(eq(trade.source, source));
    }
    // When a specific V3 pool is named, restrict to it. A curve token can have
    // several USDC/V3 pools (different fee tiers) once the permissionless
    // factory is in play; the client charts exactly one pool, so pin it here
    // for exact parity. Ignored for curve rows (their pool is null).
    if (pool && /^0x[0-9a-f]{40}$/.test(pool)) {
        conds.push(eq(trade.pool, pool as `0x${string}`));
    }
    return conds.length === 1 ? conds[0] : and(...conds);
}

app.use("*", async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
});

app.get("/candles", async (c) => {
    const token = (c.req.query("token") ?? "").toLowerCase();
    const tf = (c.req.query("tf") ?? "1m") as Timeframe;
    const source = c.req.query("source");
    const pool = c.req.query("pool")?.toLowerCase();

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
        .where(sourceFilter(token, source, pool))
        .orderBy(asc(trade.blockTime), asc(trade.blockNumber), asc(trade.logIndex))
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
    const source = c.req.query("source");
    const pool = c.req.query("pool")?.toLowerCase();
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
        .where(sourceFilter(token, source, pool))
        .orderBy(asc(trade.blockTime), asc(trade.blockNumber), asc(trade.logIndex))
        .limit(MAX_TRADES);
    return c.json({ token, source: source ?? null, count: rows.length, trades: rows });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
