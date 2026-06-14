import { describe, it, expect } from "vitest";
import { parseCctpV2Message } from "@/lib/cctp";

function pad32(hex: string): string {
    return hex.padStart(64, "0");
}

// Build a valid CCTP V2 message body for testing.
// Header layout per Circle's CCTP V2 spec (TokenMessenger/MessageTransmitter):
//   version(4) + sourceDomain(4) + destinationDomain(4) + nonce(bytes32)
//   + sender(bytes32) + recipient(bytes32) + destinationCaller(bytes32)
//   + minFinalityThreshold(4) + finalityThresholdExecuted(4) = 148 bytes
// Body layout:
//   bodyVersion(4) + burnToken(bytes32) + mintRecipient(bytes32) = 68 bytes
// Total minimum: 148 + 68 = 216 bytes = 432 hex chars.
//
// The earlier 124-byte header layout shipped here was the CCTP V1 shape;
// the parser implements V2 correctly, so the test build path needed
// updating to match. Without the fix, every "well-formed message" assertion
// hit the parser's CCTP_V2_MIN_MESSAGE_HEX gate and returned null.
function buildMessage(opts: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    nonce: bigint;
    mintRecipient: string; // 32-byte hex without 0x
    bodyExtra?: string;
}): `0x${string}` {
    const header =
        opts.version.toString(16).padStart(8, "0") + // 4 bytes
        opts.sourceDomain.toString(16).padStart(8, "0") + // 4 bytes
        opts.destinationDomain.toString(16).padStart(8, "0") + // 4 bytes
        opts.nonce.toString(16).padStart(64, "0") + // nonce as bytes32
        "00".repeat(32) + // sender bytes32 placeholder
        "00".repeat(32) + // recipient bytes32 placeholder
        "00".repeat(32) + // destinationCaller bytes32 placeholder
        "00000000" + // minFinalityThreshold
        "00000000"; // finalityThresholdExecuted
    // body = 4 body-version + 32 burnToken + 32 mintRecipient (68 bytes min)
    const body =
        "00000000" +
        pad32("01") + // burnToken placeholder
        opts.mintRecipient +
        (opts.bodyExtra ?? "");
    return ("0x" + header + body) as `0x${string}`;
}

describe("parseCctpV2Message", () => {
    it("parses a well-formed message", () => {
        const recipient = "00".repeat(12) + "deadbeefcafedeadbeefcafedeadbeefcafedead";
        const msg = buildMessage({
            version: 1,
            sourceDomain: 0, // Ethereum
            destinationDomain: 12, // Arc per CCTP V2 reservation
            nonce: 42n,
            mintRecipient: recipient,
        });
        const parsed = parseCctpV2Message(msg);
        expect(parsed).not.toBeNull();
        expect(parsed!.version).toBe(1);
        expect(parsed!.sourceDomain).toBe(0);
        expect(parsed!.destinationDomain).toBe(12);
        expect(parsed!.nonce).toBe(42n);
        expect(parsed!.mintRecipient.toLowerCase()).toBe(("0x" + recipient).toLowerCase());
    });
    it("rejects messages without 0x prefix", () => {
        expect(parseCctpV2Message("deadbeef" as `0x${string}`)).toBeNull();
    });
    it("rejects truncated messages (< 384 hex chars)", () => {
        const tooShort = "0x" + "00".repeat(100);
        expect(parseCctpV2Message(tooShort as `0x${string}`)).toBeNull();
    });
    it("audit B-5: rejects mintRecipient slice that isn't exactly 64 chars", () => {
        // Build a message whose body section is artificially truncated so the
        // mintRecipient slice would have come up short. We achieve this by
        // truncating the original message to one hex char shy of the full
        // mintRecipient extent, but still >= 384 chars total.
        const recipient = "00".repeat(12) + "deadbeefcafedeadbeefcafedeadbeefcafedead";
        const msg = buildMessage({
            version: 1,
            sourceDomain: 0,
            destinationDomain: 12,
            nonce: 1n,
            mintRecipient: recipient,
        });
        // Strip the last 64 hex chars so the mintRecipient slot is truncated.
        const truncated = msg.slice(0, msg.length - 64) as `0x${string}`;
        const parsed = parseCctpV2Message(truncated);
        expect(parsed).toBeNull();
    });
    it("accepts messages with extra body bytes (forward compatibility)", () => {
        const recipient = "00".repeat(12) + "1111222233334444555566667777888899990000";
        const msg = buildMessage({
            version: 1,
            sourceDomain: 6, // Base
            destinationDomain: 12,
            nonce: 999n,
            mintRecipient: recipient,
            bodyExtra: "ab".repeat(50), // 100 hex chars of trailing junk
        });
        const parsed = parseCctpV2Message(msg);
        expect(parsed).not.toBeNull();
        expect(parsed!.mintRecipient.toLowerCase()).toContain("1111222233334444");
    });
});
