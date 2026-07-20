/**
 * Tweet-to-launch core logic (pure, unit-tested).
 *
 * A user tweets a mention of the Arcade bot with a launch command; the backend
 * cron (api/twitter-launch/cron) reads the mention, validates the AUTHOR against
 * automated sybil criteria (account age / followers), and relays a CLANKER
 * createLaunch on their behalf (no upfront fee to the user; the relayer sponsors
 * the gas + creation fee). Creator fees are attributed to the author's Twitter
 * handle via the escrow, claimable later by the OAuth-verified owner.
 *
 * SECURITY: fees/claims must bind to the Twitter NUMERIC USER-ID, never the
 * @handle string (handles rename/recycle). The handle is display metadata only;
 * the DB stores poolId <-> user-id and claims match on the id (audit 2026-07-18).
 */

/** The launch command parsed out of a tweet. */
export interface LaunchCommand {
    /** ERC-20 symbol: uppercase alphanumeric, <= 12 chars. */
    ticker: string;
    /** ERC-20 name: <= 32 chars. */
    name: string;
}

/** Bot handle to look for, without the leading @. Configurable via env. */
export function botHandle(): string {
    return (process.env.TWITTER_BOT_HANDLE ?? "arcade").toLowerCase().replace(/^@/, "");
}

/**
 * Parse a launch command from a tweet. Requires: a mention of the bot, the verb
 * "launch", and a `$TICKER`. The name is whatever follows the ticker (mentions,
 * URLs and tags stripped), falling back to the ticker. Returns null if the tweet
 * is not a launch command.
 */
export function parseLaunchCommand(text: string): LaunchCommand | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    if (!lower.includes(`@${botHandle()}`)) return null; // must mention the bot
    // Match the pre-filter's verb set so a Claude outage (regex fallback) doesn't
    // silently drop "deploy/create/mint $X" tweets.
    if (!/\b(launch|deploy|create|mint)\b/i.test(text)) return null;

    const tickerMatch = text.match(/\$([A-Za-z][A-Za-z0-9]{0,11})\b/);
    if (!tickerMatch || tickerMatch.index === undefined) return null;
    const ticker = tickerMatch[1].toUpperCase();

    let name = text.slice(tickerMatch.index + tickerMatch[0].length);
    name = name
        .replace(/https?:\/\/\S+/g, " ") // strip URLs
        .replace(/@\w+/g, " ") // strip mentions
        .replace(/[#$]\w+/g, " ") // strip hashtags / other cashtags
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 32);
    if (!name) name = ticker;

    return { ticker, name };
}

/** Minimal X (Twitter) user shape the criteria gate needs. */
export interface XUser {
    /** Immutable numeric user-id, the canonical fee-attribution key. */
    id: string;
    username: string;
    /** ISO 8601 account creation time. */
    createdAt: string;
    followers: number;
    verified?: boolean;
}

export interface CriteriaConfig {
    minAccountAgeDays: number;
    minFollowers: number;
    requireVerified: boolean;
}

/** Automated anti-sybil gate (NOT a manual allowlist): the bot only relays for
 *  accounts that clear these bars. Tunable via env at the cron. */
export const DEFAULT_CRITERIA: CriteriaConfig = {
    minAccountAgeDays: 30,
    minFollowers: 100,
    requireVerified: false,
};

export function passesCriteria(
    user: XUser,
    cfg: CriteriaConfig,
    nowMs: number,
): { ok: boolean; reason?: string } {
    const created = Date.parse(user.createdAt);
    if (!Number.isFinite(created)) return { ok: false, reason: "bad createdAt" };
    const ageDays = (nowMs - created) / 86_400_000;
    if (ageDays < cfg.minAccountAgeDays) {
        return { ok: false, reason: `account too new (${Math.floor(ageDays)}d < ${cfg.minAccountAgeDays}d)` };
    }
    if (user.followers < cfg.minFollowers) {
        return { ok: false, reason: `too few followers (${user.followers} < ${cfg.minFollowers})` };
    }
    if (cfg.requireVerified && !user.verified) {
        return { ok: false, reason: "not verified" };
    }
    return { ok: true };
}

/** CLANKER defaults for unattended tweet launches (user-decided: 35k mcap, 1%). */
export const TWEET_LAUNCH_DEFAULTS = {
    feeTier: 1, // 1%
    startMcapUsdc: 35_000_000_000n, // 35_000 * 1e6
} as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Build the exact `createLaunch` argument tuple for a tweet launch. mode =
 * CLANKER(1); no snipe config (CLANKER rejects it); the `twitterHandle` routes
 * creator fees to the handle-gated escrow slot. metadataURI is left empty (the
 * cron may pin an image separately).
 */
export interface LaunchExtras {
    /** Token metadata URI (ipfs://…) built from the tweet's image; "" if none. */
    metadataURI?: string;
    /** Reply-to-launch: route creator2Bps of the creator fee to this address
     *  (the operator, which later forwards it to the original poster's escrow
     *  slot 1). Zero disables the split (100% to the launcher). */
    creator2?: `0x${string}`;
    creator2Bps?: number;
}

export function buildCreateLaunchArgs(
    cmd: LaunchCommand,
    handle: string,
    extras: LaunchExtras = {},
): readonly [string, string, string, number, `0x${string}`, number, number, number, number, string, bigint] {
    return [
        cmd.name, // name
        cmd.ticker, // symbol
        extras.metadataURI ?? "", // metadataURI (tweet image, pinned to IPFS)
        1, // mode = CLANKER
        extras.creator2 ?? ZERO_ADDRESS, // creator2 (reply-split relay)
        extras.creator2Bps ?? 0, // creator2Bps
        0, // snipeStartBps (CLANKER rejects > 0)
        0, // snipeDecaySeconds
        TWEET_LAUNCH_DEFAULTS.feeTier,
        handle.replace(/^@/, ""), // twitterHandle (display; canonical binding = user-id in DB)
        TWEET_LAUNCH_DEFAULTS.startMcapUsdc,
    ] as const;
}

/** Reply-split share (bps of the creator fee) routed to the original poster. */
export const REPLY_SPLIT_BPS = 5000; // 50/50
