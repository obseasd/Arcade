import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchTradesFromGoldsky } from "../../lib/goldskyTrades";
import type { Address } from "viem";

const URL = "https://goldsky.example/graphql";
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;

interface Row {
    blockTime: number;
    blockNumber: number;
    logIndex: number;
    price: number;
    volumeUsdc: number;
    isBuy: boolean;
}

// Mock a subgraph that serves `rows` newest-first with a blockNumber_lte cursor,
// paginating by `pageSize`. Reads the cursor + first out of the GraphQL query
// string the fetch was called with.
function mockSubgraph(rows: Row[], pageSize: number) {
    return vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { query: string };
        const q = body.query;
        const firstM = q.match(/first:\s*(\d+)/);
        const first = firstM ? Number(firstM[1]) : pageSize;
        const cursorM = q.match(/blockNumber_lte:\s*"(\d+)"/);
        const cursor = cursorM ? Number(cursorM[1]) : Infinity;
        const desc = [...rows].sort((a, b) => b.blockNumber - a.blockNumber);
        const page = desc.filter((r) => r.blockNumber <= cursor).slice(0, first);
        return {
            ok: true,
            json: async () => ({ data: { trades: page } }),
        } as unknown as Response;
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("fetchTradesFromGoldsky", () => {
    it("returns null when the url is unset (caller falls back to the scan)", async () => {
        const r = await fetchTradesFromGoldsky(undefined, TOKEN, 2);
        expect(r).toBeNull();
    });

    it("maps fields and returns trades sorted OLDEST-first for bucketize", async () => {
        const rows: Row[] = [
            { blockTime: 30, blockNumber: 3, logIndex: 0, price: 3, volumeUsdc: 1, isBuy: false },
            { blockTime: 10, blockNumber: 1, logIndex: 0, price: 1, volumeUsdc: 1, isBuy: true },
            { blockTime: 20, blockNumber: 2, logIndex: 0, price: 2, volumeUsdc: 1, isBuy: true },
        ];
        vi.stubGlobal("fetch", mockSubgraph(rows, 1000));
        const r = await fetchTradesFromGoldsky(URL, TOKEN, 2);
        expect(r).not.toBeNull();
        expect(r!.map((t) => t.time)).toEqual([10, 20, 30]); // ascending
        expect(r!.map((t) => t.price)).toEqual([1, 2, 3]);
        expect(r![0].isBuy).toBe(true);
    });

    it("paginates DESCENDING across pages and dedups the boundary block", async () => {
        // 5 trades, pageSize 2 -> 3 pages, with a shared boundary block per page.
        const rows: Row[] = [
            { blockTime: 10, blockNumber: 1, logIndex: 0, price: 1, volumeUsdc: 1, isBuy: true },
            { blockTime: 20, blockNumber: 2, logIndex: 0, price: 2, volumeUsdc: 1, isBuy: true },
            { blockTime: 30, blockNumber: 3, logIndex: 0, price: 3, volumeUsdc: 1, isBuy: true },
            { blockTime: 40, blockNumber: 4, logIndex: 0, price: 4, volumeUsdc: 1, isBuy: true },
            { blockTime: 50, blockNumber: 5, logIndex: 0, price: 5, volumeUsdc: 1, isBuy: true },
        ];
        const spy = mockSubgraph(rows, 2);
        vi.stubGlobal("fetch", spy);
        const r = await fetchTradesFromGoldsky(URL, TOKEN, 2, undefined, { pageSize: 2, maxPages: 10 });
        // All 5 unique trades, no dup, ascending.
        expect(r!.map((t) => t.time)).toEqual([10, 20, 30, 40, 50]);
        // Multiple pages were fetched (newest-first walk).
        expect(spy.mock.calls.length).toBeGreaterThan(1);
    });

    it("caps at maxPages and keeps the NEWEST window for a very busy token", async () => {
        // 6 trades, pageSize 2, maxPages 2. The boundary block is re-fetched +
        // deduped each page, so with pageSize 2 the window is blocks 6,5,4 (at
        // pageSize 1000 the 1-block overlap is negligible). The KEY property:
        // the NEWEST trades are kept and the oldest (10,20,30) dropped.
        const rows: Row[] = [1, 2, 3, 4, 5, 6].map((n) => ({
            blockTime: n * 10,
            blockNumber: n,
            logIndex: 0,
            price: n,
            volumeUsdc: 1,
            isBuy: true,
        }));
        vi.stubGlobal("fetch", mockSubgraph(rows, 2));
        const r = await fetchTradesFromGoldsky(URL, TOKEN, 2, undefined, { pageSize: 2, maxPages: 2 });
        expect(r!.map((t) => t.time)).toEqual([40, 50, 60]);
        // Oldest trades dropped, newest retained.
        expect(r!.map((t) => t.time)).not.toContain(10);
    });

    it("page-0 failure returns null (falls back to the scan)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response),
        );
        const r = await fetchTradesFromGoldsky(URL, TOKEN, 2);
        expect(r).toBeNull();
    });

    it("selects source from mode (2 => v3, else curve) and pins the v3 pool", async () => {
        const spy = mockSubgraph([], 1000);
        vi.stubGlobal("fetch", spy);
        const POOL = "0x2222222222222222222222222222222222222222" as Address;
        await fetchTradesFromGoldsky(URL, TOKEN, 2, POOL);
        const q1 = JSON.parse(spy.mock.calls[0][1].body).query as string;
        expect(q1).toContain('source: "v3"');
        expect(q1).toContain(`pool: "${POOL.toLowerCase()}"`);

        spy.mockClear();
        await fetchTradesFromGoldsky(URL, TOKEN, 0);
        const q2 = JSON.parse(spy.mock.calls[0][1].body).query as string;
        expect(q2).toContain('source: "curve"');
        expect(q2).not.toContain("pool:");
    });
});
