import { describe, it, expect, vi, afterEach } from "vitest";
import { createGoldskyDatafeed } from "../../lib/tradingview/goldskyDatafeed";
import { resolutionToSeconds } from "../../lib/ohlc";
import type { Address } from "viem";

const URL = "https://goldsky.example/graphql";
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;

function mockTrades(trades: { blockTime: number; blockNumber: number; logIndex: number; price: number; volumeUsdc: number; isBuy: boolean }[]) {
    return vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { trades: [...trades].sort((a, b) => b.blockNumber - a.blockNumber) } }),
    }) as unknown as Response);
}

afterEach(() => vi.restoreAllMocks());

describe("resolutionToSeconds", () => {
    it("maps TradingView resolutions to bucket seconds", () => {
        expect(resolutionToSeconds("1S")).toBe(1);
        expect(resolutionToSeconds("1")).toBe(60);
        expect(resolutionToSeconds("5")).toBe(300);
        expect(resolutionToSeconds("60")).toBe(3600);
        expect(resolutionToSeconds("240")).toBe(240 * 60);
        expect(resolutionToSeconds("1D")).toBe(86400);
    });
});

describe("createGoldskyDatafeed", () => {
    it("onReady returns a config with the supported resolutions", async () => {
        const df = createGoldskyDatafeed({ url: URL, token: TOKEN, mode: 2 });
        const config = await new Promise<{ supported_resolutions: string[] }>((res) =>
            df.onReady((c) => res(c as { supported_resolutions: string[] })),
        );
        expect(config.supported_resolutions).toContain("5");
        expect(config.supported_resolutions).toContain("1D");
    });

    it("getBars bucketizes Goldsky trades into TV bars (ms time, OHLC) within range", async () => {
        vi.stubGlobal(
            "fetch",
            mockTrades([
                { blockTime: 60, blockNumber: 1, logIndex: 0, price: 10, volumeUsdc: 1, isBuy: true },
                { blockTime: 65, blockNumber: 2, logIndex: 0, price: 12, volumeUsdc: 2, isBuy: true },
                { blockTime: 130, blockNumber: 3, logIndex: 0, price: 11, volumeUsdc: 1, isBuy: true },
            ]),
        );
        const df = createGoldskyDatafeed({ url: URL, token: TOKEN, mode: 2 });
        const bars = await new Promise<{ time: number; open: number; high: number; low: number; close: number; volume: number }[]>(
            (resolve, reject) => {
                df.getBars(
                    {},
                    "1", // 1-minute buckets (60s)
                    { from: 0, to: 1000, firstDataRequest: true },
                    (b) => resolve(b),
                    (e) => reject(new Error(e)),
                );
            },
        );
        // Bucket [60,120) merges the two trades at 60 & 65 -> one candle; [120,180)
        // has the trade at 130 -> a second candle. Times in MILLISECONDS.
        expect(bars.length).toBe(2);
        expect(bars[0].time).toBe(60_000);
        expect(bars[0].open).toBe(10);
        expect(bars[0].high).toBe(12);
        expect(bars[0].close).toBe(12);
        expect(bars[0].volume).toBe(3);
        expect(bars[1].time).toBe(120_000);
        expect(bars[1].close).toBe(11);
    });

    it("getBars reports noData when the subgraph is empty", async () => {
        vi.stubGlobal("fetch", mockTrades([]));
        const df = createGoldskyDatafeed({ url: URL, token: TOKEN, mode: 0 });
        const meta = await new Promise<{ noData: boolean }>((resolve, reject) => {
            df.getBars({}, "5", { from: 0, to: 1000, firstDataRequest: true }, (_b, m) => resolve(m), (e) => reject(new Error(e)));
        });
        expect(meta.noData).toBe(true);
    });

    it("subscribe/unsubscribe manages a poller without throwing", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", mockTrades([{ blockTime: 60, blockNumber: 1, logIndex: 0, price: 10, volumeUsdc: 1, isBuy: true }]));
        const df = createGoldskyDatafeed({ url: URL, token: TOKEN, mode: 2 });
        expect(() => df.subscribeBars({}, "1", () => {}, "guid-1")).not.toThrow();
        expect(() => df.unsubscribeBars("guid-1")).not.toThrow();
        vi.useRealTimers();
    });
});
