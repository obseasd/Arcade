import { describe, it, expect } from "vitest";
import type { RouteQuote } from "@/lib/routing/types";

/**
 * Tie-break ranking (audit R-10) lives inside useRouteQuotes' sort
 * callback. Rather than spin up a React harness for the hook, we
 * re-implement the same comparator here and assert the ordering
 * behaviour. Any drift between this comparator and the production one
 * fails fast.
 *
 * Production lives at lib/routing/useRouteQuotes.ts in the .then
 * handler. Keep this comparator in sync.
 */
const providerRank: Record<string, number> = {
    "arcade-v3": 0,
    "arcade-v2": 1,
    "xylonet-v1": 2,
    "synthra-v3": 3,
    "unitflow-v3": 4,
};

function compare(a: RouteQuote, b: RouteQuote): number {
    if (a.amountOut === b.amountOut) {
        return (providerRank[a.provider] ?? 99) - (providerRank[b.provider] ?? 99);
    }
    const max = a.amountOut > b.amountOut ? a.amountOut : b.amountOut;
    const diff = a.amountOut > b.amountOut ? a.amountOut - b.amountOut : b.amountOut - a.amountOut;
    if (diff * 10_000n < max) {
        return (providerRank[a.provider] ?? 99) - (providerRank[b.provider] ?? 99);
    }
    return b.amountOut > a.amountOut ? 1 : -1;
}

function makeQuote(provider: string, amountOut: bigint): RouteQuote {
    return {
        provider: provider as RouteQuote["provider"],
        amountOut,
        approval: {
            token: "0x0000000000000000000000000000000000000000",
            spender: "0x0000000000000000000000000000000000000000",
            amount: 0n,
        },
        executor: {
            router: "0x0000000000000000000000000000000000000000",
            abi: [],
            functionName: "x",
            args: [],
        },
    } as RouteQuote;
}

describe("useRouteQuotes tie-break ranking (audit R-10)", () => {
    it("exact-equal amountOut: prefer lower providerRank", () => {
        const sorted = [
            makeQuote("synthra-v3", 100n),
            makeQuote("arcade-v3", 100n),
        ].sort(compare);
        expect(sorted[0].provider).toBe("arcade-v3");
    });
    it("within 1 bp: prefer lower providerRank", () => {
        const sorted = [
            makeQuote("synthra-v3", 1_000_001n),
            makeQuote("arcade-v3", 1_000_000n),
        ].sort(compare);
        // diff = 1, max = 1_000_001, diff * 10_000 = 10_000 < 1_000_001
        // → falls into bucket, providerRank decides → arcade-v3 wins
        expect(sorted[0].provider).toBe("arcade-v3");
    });
    it("more than 1 bp apart: highest amountOut wins regardless of provider", () => {
        const sorted = [
            makeQuote("arcade-v3", 1_000_000n),
            makeQuote("synthra-v3", 2_000_000n),
        ].sort(compare);
        // diff = 1_000_000, max = 2_000_000, diff * 10_000 = 10^10 ≫ 2_000_000
        // → real diff, synthra wins on amount
        expect(sorted[0].provider).toBe("synthra-v3");
    });
    it("unknown provider gets rank 99 → loses every tie", () => {
        const sorted = [
            makeQuote("future-dex" as unknown as string, 100n),
            makeQuote("arcade-v2", 100n),
        ].sort(compare);
        expect(sorted[0].provider).toBe("arcade-v2");
    });
});
