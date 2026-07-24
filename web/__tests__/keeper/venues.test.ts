import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import type { RouteQuote } from "@/lib/routing/types";
import { selectBestVenue, type OrbsVenueAdapter } from "@/lib/keeper/venues";

const V2_ROUTER = "0xaa00000000000000000000000000000000000001" as Address;
const V3_ROUTER = "0xaa00000000000000000000000000000000000002" as Address;
const XYLO_ROUTER = "0xaa00000000000000000000000000000000000003" as Address;
const V2_ADAPTER = "0xbb00000000000000000000000000000000000001" as Address;
const V3_ADAPTER = "0xbb00000000000000000000000000000000000002" as Address;
const XYLO_ADAPTER = "0xbb00000000000000000000000000000000000003" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EURC = "0x8900000000000000000000000000000000000000" as Address;

// A registry where all three venues are wired.
const REGISTRY: OrbsVenueAdapter[] = [
    {
        providerId: "arcade-v2",
        adapter: V2_ADAPTER,
        router: V2_ROUTER,
        toVenue: (_q, i, o) => ({ kind: "v2", router: V2_ROUTER, path: [i, o] }),
    },
    {
        providerId: "xylonet-v1",
        adapter: XYLO_ADAPTER,
        router: XYLO_ROUTER,
        toVenue: (_q, i, o) => ({ kind: "v2", router: XYLO_ROUTER, path: [i, o] }),
    },
    {
        providerId: "arcade-v3",
        adapter: V3_ADAPTER,
        router: V3_ROUTER,
        toVenue: (q, i, o) => ({ kind: "v3", router: V3_ROUTER, tokenIn: i, tokenOut: o, fee: q.fee ?? 3000 }),
    },
];

const quote = (provider: RouteQuote["provider"], amountOut: bigint, fee?: number): RouteQuote =>
    ({
        provider,
        amountOut,
        fee,
        approval: { token: USDC, spender: V2_ROUTER, amount: 0n },
        executor: { router: V2_ROUTER, abi: [], functionName: "x", args: [] },
    }) as RouteQuote;

describe("selectBestVenue", () => {
    it("picks the highest-output wired venue (XyloNet stable pool beats a thin Arcade V2)", () => {
        const quotes = [
            quote("arcade-v2", 60_000000n),
            quote("xylonet-v1", 92_000000n), // best (stable pool for USDC/EURC)
            quote("arcade-v3", 90_000000n),
        ];
        const sel = selectBestVenue(quotes, REGISTRY, USDC, EURC);
        expect(sel?.providerId).toBe("xylonet-v1");
        expect(sel?.adapter).toBe(XYLO_ADAPTER);
        expect(sel?.quotedOut).toBe(92_000000n);
        expect(sel?.venue).toEqual({ kind: "v2", router: XYLO_ROUTER, path: [USDC, EURC] });
    });

    it("builds a v3 venue with the quote's fee tier when V3 wins", () => {
        const quotes = [quote("arcade-v2", 10n), quote("arcade-v3", 100n, 500)];
        const sel = selectBestVenue(quotes, REGISTRY, USDC, EURC);
        expect(sel?.providerId).toBe("arcade-v3");
        expect(sel?.venue).toEqual({
            kind: "v3",
            router: V3_ROUTER,
            tokenIn: USDC,
            tokenOut: EURC,
            fee: 500,
        });
    });

    it("SKIPS a better-priced venue whose adapter is not deployed yet", () => {
        // Synthra quotes best but has no registry entry -> not fillable by Orbs.
        const quotes = [quote("synthra-v3", 99_000000n), quote("arcade-v2", 60_000000n)];
        const sel = selectBestVenue(quotes, REGISTRY, USDC, EURC);
        expect(sel?.providerId).toBe("arcade-v2"); // falls back to the best WIRED venue
    });

    it("returns null when no quote maps to a wired adapter", () => {
        const quotes = [quote("synthra-v3", 99n), quote("unitflow-v3", 88n)];
        expect(selectBestVenue(quotes, REGISTRY, USDC, EURC)).toBeNull();
    });

    it("ignores an entry whose adapter is undefined (not yet deployed)", () => {
        const partial: OrbsVenueAdapter[] = REGISTRY.map((r) =>
            r.providerId === "xylonet-v1" ? { ...r, adapter: undefined } : r,
        );
        const quotes = [quote("xylonet-v1", 92n), quote("arcade-v2", 60n)];
        const sel = selectBestVenue(quotes, partial, USDC, EURC);
        expect(sel?.providerId).toBe("arcade-v2"); // xylonet skipped (no adapter)
    });

    it("skips non-positive quotes", () => {
        const quotes = [quote("arcade-v2", 0n), quote("arcade-v3", 5n)];
        expect(selectBestVenue(quotes, REGISTRY, USDC, EURC)?.providerId).toBe("arcade-v3");
    });
});
