import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getGoldskyStats } from "../../lib/stats";

const URL = "https://goldsky.example/graphql";

function mockGlobal(global: unknown, meta = { block: { number: 52150260 } }) {
    return vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { global, _meta: meta } }),
    }) as unknown as Response);
}

beforeEach(() => {
    process.env.NEXT_PUBLIC_GOLDSKY_URL = URL;
});
afterEach(() => {
    delete process.env.NEXT_PUBLIC_GOLDSKY_URL;
    vi.restoreAllMocks();
});

describe("getGoldskyStats", () => {
    it("returns null when the subgraph URL is unset (caller falls back)", async () => {
        delete process.env.NEXT_PUBLIC_GOLDSKY_URL;
        expect(await getGoldskyStats()).toBeNull();
    });

    it("parses the Global singleton into a StatsSnapshot (decimal volume -> micros)", async () => {
        vi.stubGlobal(
            "fetch",
            mockGlobal({
                totalVolumeUsdc: "6393.321332",
                tradeCount: 3971,
                tokenCount: 12,
                graduatedCount: 3,
                uniqueTraders: 2722,
            }),
        );
        const s = await getGoldskyStats();
        expect(s).not.toBeNull();
        expect(s!.volumeUsdcMicros).toBe(6_393_321_332n);
        expect(s!.txCount).toBe(3971);
        expect(s!.uniqueWallets).toBe(2722);
        expect(s!.tokensLaunched).toBe(12);
        expect(s!.tokensGraduated).toBe(3);
        expect(s!.truncated).toBe(false);
        expect(s!.asOfBlock).toBe(52150260n);
    });

    it("handles whole numbers and short fractions in the volume string", async () => {
        vi.stubGlobal("fetch", mockGlobal({ totalVolumeUsdc: "100", tradeCount: 1, tokenCount: 0, graduatedCount: 0, uniqueTraders: 1 }));
        expect((await getGoldskyStats())!.volumeUsdcMicros).toBe(100_000_000n);
        vi.stubGlobal("fetch", mockGlobal({ totalVolumeUsdc: "0.5", tradeCount: 1, tokenCount: 0, graduatedCount: 0, uniqueTraders: 1 }));
        expect((await getGoldskyStats())!.volumeUsdcMicros).toBe(500_000n);
    });

    it("returns null on a non-ok response or missing global (fallback)", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response));
        expect(await getGoldskyStats()).toBeNull();
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) }) as unknown as Response));
        expect(await getGoldskyStats()).toBeNull();
    });
});
