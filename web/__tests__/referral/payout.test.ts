import { describe, it, expect } from "vitest";
import { computeReferralEarningsMicros } from "../../lib/referralPayout";

describe("computeReferralEarningsMicros", () => {
    it("is 10% of a 0.15% protocol fee = 0.015% of volume", () => {
        // 1 USDC volume (1e6 micros), 15 bps protocol fee.
        // 1e6 * 15 * 1000 / 1e8 = 150 micros = 0.00015 USDC.
        expect(computeReferralEarningsMicros(1_000_000n, 15n)).toBe(150n);
        // 1000 USDC -> 0.15 USDC earnings.
        expect(computeReferralEarningsMicros(1_000_000_000n, 15n)).toBe(150_000n);
    });

    it("scales linearly with the protocol bps", () => {
        expect(computeReferralEarningsMicros(1_000_000n, 30n)).toBe(300n);
        expect(computeReferralEarningsMicros(1_000_000n, 0n)).toBe(0n);
    });

    it("returns 0 for non-positive volume (never negative)", () => {
        expect(computeReferralEarningsMicros(0n, 15n)).toBe(0n);
        expect(computeReferralEarningsMicros(-5n, 15n)).toBe(0n);
    });

    it("floors (under-credits by sub-micro dust, never over-pays)", () => {
        // 1 micro * 15 * 1000 / 1e8 = 15000/1e8 = 0.00015 -> floors to 0.
        expect(computeReferralEarningsMicros(1n, 15n)).toBe(0n);
    });

    it("does not overflow at large volume (BigInt)", () => {
        const huge = 10n ** 18n; // 1e12 USDC in micros
        expect(computeReferralEarningsMicros(huge, 15n)).toBe((huge * 15n * 1000n) / 100_000_000n);
    });
});
