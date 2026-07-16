import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { computeCreatorFeeMicros, getGoldskyCreatorFees } from "../../lib/stats";
import { cctpDomainLabel } from "../../lib/cctp";

const URL = "https://goldsky.example/graphql";

function mockCreators(creators: unknown) {
    return vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { creators } }),
    }) as unknown as Response);
}

beforeEach(() => {
    process.env.NEXT_PUBLIC_GOLDSKY_URL = URL;
});
afterEach(() => {
    delete process.env.NEXT_PUBLIC_GOLDSKY_URL;
    vi.restoreAllMocks();
});

describe("computeCreatorFeeMicros", () => {
    it("applies the two-bucket default rates (curve 30 bps, graduated 80 bps)", () => {
        // 10_000 USDC curve = 10_000_000_000 * 30 / 1e4 = 30_000_000 ($30)
        expect(computeCreatorFeeMicros(10_000_000_000n, 0n)).toBe(30_000_000n);
        // 10_000 USDC graduated = 10_000_000_000 * 80 / 1e4 = 80_000_000 ($80)
        expect(computeCreatorFeeMicros(0n, 10_000_000_000n)).toBe(80_000_000n);
        // both buckets sum
        expect(computeCreatorFeeMicros(10_000_000_000n, 10_000_000_000n)).toBe(110_000_000n);
    });

    it("floors sub-micro dust (never over-estimates)", () => {
        // curve: 333 * 30 / 1e4 = 0.999 -> 0; 334 * 30 / 1e4 = 1.002 -> 1
        expect(computeCreatorFeeMicros(333n, 0n)).toBe(0n);
        expect(computeCreatorFeeMicros(334n, 0n)).toBe(1n);
    });

    it("returns 0 for non-positive volume or zero bps", () => {
        expect(computeCreatorFeeMicros(0n, 0n)).toBe(0n);
        expect(computeCreatorFeeMicros(-5n, -5n)).toBe(0n);
        expect(computeCreatorFeeMicros(1_000_000_000n, 1_000_000_000n, 0n, 0n)).toBe(0n);
    });

    it("honours explicit bps overrides per bucket", () => {
        // curve 50 bps (PUMP), graduated 100 bps
        expect(computeCreatorFeeMicros(10_000_000_000n, 10_000_000_000n, 50n, 100n)).toBe(
            50_000_000n + 100_000_000n,
        );
    });
});

describe("getGoldskyCreatorFees", () => {
    it("returns [] when the subgraph URL is unset", async () => {
        delete process.env.NEXT_PUBLIC_GOLDSKY_URL;
        expect(await getGoldskyCreatorFees()).toEqual([]);
    });

    it("parses creators and derives the two-bucket fee (decimal volume -> micros)", async () => {
        vi.stubGlobal(
            "fetch",
            mockCreators([
                // 10_000 total, 4_000 graduated -> curve 6_000. fee = 6000*30/1e4 + 4000*80/1e4 = 18 + 32 = $50
                { id: "0xAbC0000000000000000000000000000000000001", tokenCount: 3, totalVolumeUsdc: "10000", graduatedVolumeUsdc: "4000" },
                // 1_000 total, 0 graduated (curve only) -> 1000*30/1e4 = $3
                { id: "0xDeF0000000000000000000000000000000000002", tokenCount: 1, totalVolumeUsdc: "1000", graduatedVolumeUsdc: "0" },
                // >6dp on total: MUST truncate (floor), never round up.
                { id: "0x1230000000000000000000000000000000000003", tokenCount: 1, totalVolumeUsdc: "1.1234567", graduatedVolumeUsdc: "0" },
            ]),
        );
        const rows = await getGoldskyCreatorFees();
        expect(rows).toHaveLength(3);
        // id lowercased
        expect(rows[0].creator).toBe("0xabc0000000000000000000000000000000000001");
        expect(rows[0].volumeMicros).toBe(10_000_000_000n);
        // curve 6_000 * 30 + grad 4_000 * 80 (bps/1e4) = 18_000_000 + 32_000_000
        expect(rows[0].feeMicros).toBe(18_000_000n + 32_000_000n);
        expect(rows[1].volumeMicros).toBe(1_000_000_000n);
        expect(rows[1].feeMicros).toBe(3_000_000n); // 1000 curve * 30 bps
        // "1.1234567" -> 1_123_456 (7th digit dropped, NOT rounded to ...457)
        expect(rows[2].volumeMicros).toBe(1_123_456n);
    });

    it("falls back to first:10 on a NaN limit (never emits first:NaN)", async () => {
        const fetchMock = mockCreators([]);
        vi.stubGlobal("fetch", fetchMock);
        await getGoldskyCreatorFees(Number.NaN);
        const body = String((fetchMock.mock.calls[0]?.[1] as { body?: string })?.body ?? "");
        expect(body).toContain("first: 10");
        expect(body).not.toContain("NaN");
    });

    it("returns [] on a non-ok response or malformed body", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response));
        expect(await getGoldskyCreatorFees()).toEqual([]);
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) }) as unknown as Response));
        expect(await getGoldskyCreatorFees()).toEqual([]);
    });
});

describe("cctpDomainLabel", () => {
    it("resolves known domains and strips the network suffix", () => {
        expect(cctpDomainLabel(0)).toBe("Ethereum");
        expect(cctpDomainLabel(6)).toBe("Base");
        expect(cctpDomainLabel(3)).toBe("Arbitrum"); // "Arbitrum Sepolia" -> "Arbitrum"
    });

    it("never returns the Arc destination as a source label", () => {
        // domain 26 = Arc testnet, excluded from the source lookup
        expect(cctpDomainLabel(26)).toBe("Domain 26");
    });

    it("falls back to Domain N for an unknown domain", () => {
        expect(cctpDomainLabel(99)).toBe("Domain 99");
    });
});
