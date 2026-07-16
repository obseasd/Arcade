import { ponder } from "ponder:registry";
import { trade, pool } from "ponder:schema";
import {
    priceFromNewPriceQ64,
    priceFromSqrtX96,
    usdcVolumeFromRaw,
} from "./lib/price";

/**
 * Event handlers. Each on-chain trade becomes one `trade` row with its
 * USDC-per-token price already derived (identical math to the client's
 * useTokenCandles), so the /candles API only has to bucketize.
 */

const USDC = (process.env.USDC_ADDRESS ?? "").toLowerCase();
// Fail fast: an unset/invalid USDC address would make every V3 pool look
// "not USDC", silently indexing ZERO v3 trades with no error.
if (!/^0x[0-9a-f]{40}$/.test(USDC)) {
    throw new Error(
        "USDC_ADDRESS is unset or not a 20-byte hex address; V3 pool filtering needs it",
    );
}

function tradeId(txHash: string, logIndex: number): string {
    return `${txHash}-${logIndex}`;
}

// ---- Curve / launchpad ----

ponder.on("Launchpad:Buy", async ({ event, context }) => {
    await context.db.insert(trade).values({
        id: tradeId(event.transaction.hash, event.log.logIndex),
        token: event.args.token,
        source: "curve",
        pool: null,
        price: priceFromNewPriceQ64(event.args.newPriceQ64),
        volumeUsdc: usdcVolumeFromRaw(event.args.usdcIn),
        isBuy: true,
        blockTime: Number(event.block.timestamp),
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
    });
});

ponder.on("Launchpad:Sell", async ({ event, context }) => {
    await context.db.insert(trade).values({
        id: tradeId(event.transaction.hash, event.log.logIndex),
        token: event.args.token,
        source: "curve",
        pool: null,
        price: priceFromNewPriceQ64(event.args.newPriceQ64),
        volumeUsdc: usdcVolumeFromRaw(event.args.usdcOut),
        isBuy: false,
        blockTime: Number(event.block.timestamp),
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
    });
});

// ---- V3 pools ----

// Record each USDC-paired pool at creation so the Swap handler knows the
// token0 orientation. Non-USDC pools are ignored (no USDC price reference).
ponder.on("V3Factory:PoolCreated", async ({ event, context }) => {
    const token0 = event.args.token0.toLowerCase();
    const token1 = event.args.token1.toLowerCase();
    const usdcIsToken0 = token0 === USDC;
    const usdcIsToken1 = token1 === USDC;
    if (!usdcIsToken0 && !usdcIsToken1) return; // not a USDC pool

    await context.db.insert(pool).values({
        id: event.args.pool,
        token0: event.args.token0,
        token1: event.args.token1,
        token: usdcIsToken0 ? event.args.token1 : event.args.token0,
        usdcIsToken0,
    });
});

ponder.on("V3Pool:Swap", async ({ event, context }) => {
    // Only price swaps on a USDC pool we recorded; skip everything else.
    const p = await context.db.find(pool, { id: event.log.address });
    if (!p) return;

    const price = priceFromSqrtX96(event.args.sqrtPriceX96, p.usdcIsToken0);
    // The USDC delta: positive = pool received USDC = the user bought the token.
    const usdcRaw = p.usdcIsToken0 ? event.args.amount0 : event.args.amount1;

    await context.db.insert(trade).values({
        id: tradeId(event.transaction.hash, event.log.logIndex),
        token: p.token,
        source: "v3",
        pool: p.id,
        price,
        volumeUsdc: usdcVolumeFromRaw(usdcRaw),
        isBuy: usdcRaw > 0n,
        blockTime: Number(event.block.timestamp),
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
    });
});
