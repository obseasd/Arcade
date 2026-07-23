import { describe, it, expect } from "vitest";
import {
    computeReferralEarningsMicros,
    computeReferralFromProtocolFeeMicros,
} from "../../lib/referralPayout";

describe("computeReferralFromProtocolFeeMicros", () => {
    it("pays 10% of the REAL protocol fee (REFERRAL_SHARE_BPS = 1000)", () => {
        // 1 USDC of protocol fee -> 0.10 USDC to the referrer.
        expect(computeReferralFromProtocolFeeMicros(1_000_000n)).toBe(100_000n);
        // 0.15 USDC protocol fee (what 100 USDC of graduated volume yields) ->
        // 0.015 USDC, matching the legacy 0.015%-of-volume figure when the
        // protocol take really is 15 bps -- but now it FOLLOWS the real fee.
        expect(computeReferralFromProtocolFeeMicros(150_000n)).toBe(15_000n);
    });

    it("is zero when the trade generated no protocol fee (the anti-drain property)", () => {
        // A wash trade on a pool the trader LPs, or an unindexed venue, yields
        // protocolFee = 0 -> the referrer earns nothing -> nothing to drain.
        expect(computeReferralFromProtocolFeeMicros(0n)).toBe(0n);
        expect(computeReferralFromProtocolFeeMicros(-5n)).toBe(0n);
    });

    it("floors, never over-pays", () => {
        // 9 micros * 1000 / 1e4 = 0.9 -> floors to 0.
        expect(computeReferralFromProtocolFeeMicros(9n)).toBe(0n);
        expect(computeReferralFromProtocolFeeMicros(10n)).toBe(1n);
    });

    it("does not overflow at large fees (BigInt)", () => {
        const huge = 10n ** 18n;
        expect(computeReferralFromProtocolFeeMicros(huge)).toBe((huge * 1000n) / 10_000n);
    });
});

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
