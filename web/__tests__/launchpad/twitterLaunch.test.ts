import { describe, it, expect } from "vitest";
import {
    parseLaunchCommand,
    passesCriteria,
    buildCreateLaunchArgs,
    DEFAULT_CRITERIA,
    TWEET_LAUNCH_DEFAULTS,
    type XUser,
} from "@/lib/twitterLaunch";

// Bot handle defaults to "arcade" (no TWITTER_BOT_HANDLE env in test).

describe("parseLaunchCommand", () => {
    it("parses a well-formed launch tweet", () => {
        const c = parseLaunchCommand("@arcade launch $DOGE Doge Coin to the moon");
        expect(c).toEqual({ ticker: "DOGE", name: "Doge Coin to the moon" });
    });

    it("uppercases the ticker and caps the name at 32 chars", () => {
        const c = parseLaunchCommand(
            "@arcade launch $abc " + "x".repeat(50),
        );
        expect(c?.ticker).toBe("ABC");
        expect(c?.name.length).toBe(32);
    });

    it("strips URLs, mentions and tags from the name, falls back to ticker", () => {
        const c = parseLaunchCommand("@arcade launch $PEPE @someone https://x.com/a #memecoin");
        expect(c).toEqual({ ticker: "PEPE", name: "PEPE" });
    });

    it("requires the bot mention", () => {
        expect(parseLaunchCommand("launch $DOGE Doge")).toBeNull();
    });

    it("requires the launch verb", () => {
        expect(parseLaunchCommand("@arcade check out $DOGE")).toBeNull();
    });

    it("requires a $ticker", () => {
        expect(parseLaunchCommand("@arcade launch my token")).toBeNull();
    });

    it("rejects an over-long ticker (no valid <=12 boundary)", () => {
        // A 16-char cashtag has no word boundary within 12 chars -> rejected.
        expect(parseLaunchCommand("@arcade launch $ABCDEFGHIJKLMNOP token")).toBeNull();
        // A 12-char ticker is the max accepted.
        expect(parseLaunchCommand("@arcade launch $ABCDEFGHIJKL tok")?.ticker).toBe("ABCDEFGHIJKL");
    });

    it("is case-insensitive on the mention and verb", () => {
        const c = parseLaunchCommand("@Arcade LAUNCH $Wif dogwifhat");
        expect(c).toEqual({ ticker: "WIF", name: "dogwifhat" });
    });
});

describe("passesCriteria", () => {
    const now = Date.parse("2026-07-18T00:00:00Z");
    const base: XUser = {
        id: "12345",
        username: "alice",
        createdAt: "2020-01-01T00:00:00Z", // old
        followers: 500,
        verified: false,
    };

    it("passes an old, well-followed account", () => {
        expect(passesCriteria(base, DEFAULT_CRITERIA, now).ok).toBe(true);
    });

    it("rejects a too-new account", () => {
        const u = { ...base, createdAt: "2026-07-10T00:00:00Z" }; // 8 days
        const r = passesCriteria(u, DEFAULT_CRITERIA, now);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("too new");
    });

    it("rejects too few followers", () => {
        const u = { ...base, followers: 3 };
        const r = passesCriteria(u, DEFAULT_CRITERIA, now);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("followers");
    });

    it("enforces verified when required", () => {
        const cfg = { ...DEFAULT_CRITERIA, requireVerified: true };
        expect(passesCriteria(base, cfg, now).ok).toBe(false);
        expect(passesCriteria({ ...base, verified: true }, cfg, now).ok).toBe(true);
    });

    it("rejects an unparseable createdAt", () => {
        expect(passesCriteria({ ...base, createdAt: "nonsense" }, DEFAULT_CRITERIA, now).ok).toBe(false);
    });
});

describe("buildCreateLaunchArgs", () => {
    it("builds CLANKER args with no snipe and handle attribution", () => {
        const args = buildCreateLaunchArgs({ ticker: "DOGE", name: "Doge Coin" }, "@alice");
        expect(args[0]).toBe("Doge Coin"); // name
        expect(args[1]).toBe("DOGE"); // symbol
        expect(args[3]).toBe(1); // mode = CLANKER
        expect(args[6]).toBe(0); // snipeStartBps must be 0 (CLANKER rejects >0)
        expect(args[8]).toBe(TWEET_LAUNCH_DEFAULTS.feeTier); // 1%
        expect(args[9]).toBe("alice"); // handle, @ stripped
        expect(args[10]).toBe(TWEET_LAUNCH_DEFAULTS.startMcapUsdc); // 35k
    });
});
