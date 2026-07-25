import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { pickBestVenue, v2DirectVenue, type DirectVenueCandidate } from "@/lib/keeper/directVenues";

const ARCADE_V2 = "0xaa00000000000000000000000000000000000001" as Address;
const XYLO = "0xaa00000000000000000000000000000000000002" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EURC = "0x8900000000000000000000000000000000000000" as Address;

const cand = (label: string, router: Address, quotedOut: bigint): DirectVenueCandidate => ({
    label,
    quotedOut,
    venue: v2DirectVenue(router, USDC, EURC),
});

describe("v2DirectVenue", () => {
    it("builds a single-hop v2 venue with the exact router and path it will execute", () => {
        expect(v2DirectVenue(ARCADE_V2, USDC, EURC)).toEqual({
            kind: "v2",
            router: ARCADE_V2,
            path: [USDC, EURC],
        });
    });
});

describe("pickBestVenue", () => {
    it("returns the highest-output candidate (XyloNet stable pool beats a thin Arcade V2)", () => {
        const best = pickBestVenue([
            cand("arcade-v2", ARCADE_V2, 60_000000n),
            cand("xylonet", XYLO, 92_000000n),
        ]);
        expect(best?.label).toBe("xylonet");
        expect(best?.quotedOut).toBe(92_000000n);
        expect(best?.venue.router).toBe(XYLO);
    });

    it("keeps Arcade V2 when it quotes better", () => {
        const best = pickBestVenue([
            cand("arcade-v2", ARCADE_V2, 95_000000n),
            cand("xylonet", XYLO, 90_000000n),
        ]);
        expect(best?.label).toBe("arcade-v2");
    });

    it("ignores non-positive quotes (a pair with no pool on that venue)", () => {
        const best = pickBestVenue([
            cand("arcade-v2", ARCADE_V2, 0n),
            cand("xylonet", XYLO, 5n),
        ]);
        expect(best?.label).toBe("xylonet");
    });

    it("returns null when no candidate quotes positive", () => {
        expect(pickBestVenue([cand("arcade-v2", ARCADE_V2, 0n)])).toBeNull();
        expect(pickBestVenue([])).toBeNull();
    });

    it("breaks ties by input order (first wins, deterministic)", () => {
        const best = pickBestVenue([
            cand("arcade-v2", ARCADE_V2, 50n),
            cand("xylonet", XYLO, 50n),
        ]);
        expect(best?.label).toBe("arcade-v2");
    });
});
