import { describe, it, expect } from "vitest";
import {
    priceFromNewPriceQ64,
    priceFromSqrtX96,
    bucketize,
    type Trade,
} from "../../../indexer/src/lib/price";

/**
 * Parity guard: the indexer's price/OHLC module MUST produce the same numbers
 * as web/lib/hooks/useTokenCandles.ts, or the chart jumps when a token crosses
 * the indexer<->client-scan fallback boundary. These reproduce the exact
 * formulas inline and assert the ported module matches.
 */

describe("priceFromNewPriceQ64 parity", () => {
    it("matches the useTokenCandles curve formula", () => {
        for (const priceQ64 of [1n << 64n, 5n << 64n, (5n << 64n) / 1000n, 123456789n << 40n]) {
            const priceE24 = (priceQ64 * 10n ** 24n) >> 64n;
            const expected = (Number(priceE24) / 1e24) * 1e12;
            expect(priceFromNewPriceQ64(priceQ64)).toBe(expected);
        }
    });
    it("a 1.0 USDC/token Q64 price reads ~1e12 (raw-unit scale, as in the hook)", () => {
        // 1<<64 means 1 raw-USDC per raw-token; *1e12 lifts 6-dec/18-dec to human.
        expect(priceFromNewPriceQ64(1n << 64n)).toBeCloseTo(1e12, 0);
    });
});

describe("priceFromSqrtX96 parity", () => {
    const Q96 = 2n ** 96n;
    const Q192 = 2n ** 192n;
    it("matches the useTokenCandles V3 formula both token0 orientations", () => {
        // sqrtPriceX96 for price ratio 1:1 is 1*Q96.
        const sqrt = Q96;
        for (const usdcIsToken0 of [true, false]) {
            const num = sqrt * sqrt;
            const ratioE24 = usdcIsToken0
                ? (Q192 * 10n ** 24n) / num
                : (num * 10n ** 24n) / Q192;
            const expected = Number(ratioE24) / 1e12;
            expect(priceFromSqrtX96(sqrt, usdcIsToken0)).toBe(expected);
        }
    });
});

describe("bucketize parity", () => {
    it("chains open onto the previous close (no flat dojis)", () => {
        const trades: Trade[] = [
            { time: 0, price: 10, volumeUsdc: 1 },
            { time: 61, price: 12, volumeUsdc: 1 },
        ];
        const c = bucketize(trades, 60);
        expect(c).toHaveLength(2);
        expect(c[1].open).toBe(10); // chained onto candle 0's close
        expect(c[1].close).toBe(12);
    });

    it("breaks a candle on a buy->sell side change inside the same bucket", () => {
        const trades: Trade[] = [
            { time: 5, price: 10, volumeUsdc: 1, isBuy: true },
            { time: 6, price: 9, volumeUsdc: 1, isBuy: false }, // same 60s bucket, side flips
        ];
        const c = bucketize(trades, 60);
        expect(c).toHaveLength(2); // NOT merged into one candle
        expect(c[0].close).toBe(10);
        expect(c[1].close).toBe(9);
    });

    it("returns empty for no trades", () => {
        expect(bucketize([], 60)).toEqual([]);
    });
});
