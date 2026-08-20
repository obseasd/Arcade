import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import {
    createPublicClient,
    createWalletClient,
    decodeEventLog,
    http,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ADDRESSES } from "@/lib/constants";
import { ARC_CHAIN } from "@/lib/serverRpc";
import { ARCADE_HOOK_ABI } from "@/lib/abis/arcadeHook";
import {
    parseLaunchCommand,
    passesCriteria,
    buildCreateLaunchArgs,
    DEFAULT_CRITERIA,
    botHandle,
    REPLY_SPLIT_BPS,
    type XUser,
    type CriteriaConfig,
    type LaunchCommand,
} from "@/lib/twitterLaunch";
import { hasLaunchIntent, parseLaunchWithClaude } from "@/lib/twitterLaunchParse";
import { forwarderAddress } from "@/lib/twitterTokenForward";
import { deliverPendingTokenSides } from "@/lib/twitterTokenDeliver";
import { postLaunchReply } from "@/lib/twitterReply";
import {
    isTweetProcessed,
    recordLaunchTweet,
    userLaunchCountSince,
    globalLaunchCountSince,
    reserveTweet,
    getSinceId,
    setSinceId,
} from "@/lib/twitterLaunchPersistence";
import { isDbConfigured } from "@/lib/db";
import { pinFile, pinJson } from "@/lib/pinata";

/**
 * Tweet-to-launch cron (v2). Reads recent mentions of the bot, validates each
 * author against automated anti-sybil criteria (followers>=100, age>=30d),
 * parses the launch command with Claude Haiku (regex fallback), pins the
 * tweet's image as the token logo, and RELAYS a CLANKER createLaunch on the
 * author's behalf (the operator sponsors gas + the 3 USDC creation fee).
 *
 * Reply-to-launch (50/50): if the launch tweet is a reply, the ORIGINAL POSTER
 * gets half the creator fee. On-chain, creator2 routes 50% to the operator; the
 * DB records (poolId -> original poster) so the claim-time reconciliation can
 * credit the poster's escrow slot 1. The launcher keeps slot 0.
 *
 * Cost control: `since_id` makes each poll fetch only NEW tweets (X pay-per-use
 * bills per post returned). A cheap keyword pre-filter runs before any paid
 * Claude parse.
 *
 * Requires: X_BEARER_TOKEN, COMPOUNDER_OPERATOR_PRIVATE_KEY (funded + USDC-
 * approved to the hook), ANTHROPIC_API_KEY (else regex-only parse), PINATA_JWT
 * (else no logo), a cron secret, the twitter_launches schema (migrate v2), and a
 * configured hook address.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_LAUNCHES_PER_RUN = 5;
const PER_USER_DAILY_LIMIT = Number(process.env.TWEET_LAUNCH_PER_USER_DAILY ?? "1");
// Circuit breaker: a hard global ceiling on sponsored launches per 24h so a sybil
// fleet can't drain the operator's gas + 3-USDC-per-launch sponsorship.
const GLOBAL_DAILY_LIMIT = Number(process.env.TWEET_LAUNCH_GLOBAL_DAILY ?? "50");

// X/Twitter snowflake epoch (ms). A tweet id encodes its creation time as
// (id >> 22) + epoch, letting us age-check a stored since_id without a lookup.
const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;
function tweetIdToMs(id: string): number | null {
    try {
        return Number((BigInt(id) >> 22n) + X_SNOWFLAKE_EPOCH_MS);
    } catch {
        return null;
    }
}

function criteriaFromEnv(): CriteriaConfig {
    return {
        minAccountAgeDays: Number(process.env.TWEET_LAUNCH_MIN_ACCOUNT_AGE_DAYS ?? DEFAULT_CRITERIA.minAccountAgeDays),
        minFollowers: Number(process.env.TWEET_LAUNCH_MIN_FOLLOWERS ?? DEFAULT_CRITERIA.minFollowers),
        requireVerified: process.env.TWEET_LAUNCH_REQUIRE_VERIFIED === "true",
    };
}

interface Mention {
    tweetId: string;
    text: string;
    author: XUser;
    /** Original poster of the replied-to tweet (reply-to-launch), or null. */
    opUser: XUser | null;
    /** First photo attached to the tweet, for the token logo, or null. */
    imageUrl: string | null;
}

interface XUserRaw {
    id: string;
    username: string;
    created_at: string;
    verified?: boolean;
    public_metrics?: { followers_count: number };
}

function toXUser(u: XUserRaw): XUser {
    return {
        id: u.id,
        username: u.username,
        createdAt: u.created_at,
        followers: u.public_metrics?.followers_count ?? 0,
        verified: u.verified,
    };
}

/** Fetch recent bot mentions (launch/deploy/create) with author + reply + media
 *  context, only newer than `sinceId`. */
async function fetchLaunchMentions(bearer: string, sinceId: string | null): Promise<Mention[]> {
    const query = encodeURIComponent(`@${botHandle()} (launch OR deploy OR create) -is:retweet`);
    let url =
        `https://api.twitter.com/2/tweets/search/recent?query=${query}` +
        `&max_results=20` +
        `&tweet.fields=author_id,created_at,referenced_tweets,in_reply_to_user_id,attachments` +
        `&expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys` +
        `&user.fields=created_at,public_metrics,verified,username` +
        `&media.fields=url,type`;
    if (sinceId) url += `&since_id=${sinceId}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
        data?: {
            id: string;
            text: string;
            author_id: string;
            referenced_tweets?: { type: string; id: string }[];
            attachments?: { media_keys?: string[] };
        }[];
        includes?: {
            users?: XUserRaw[];
            tweets?: { id: string; author_id: string }[];
            media?: { media_key: string; type: string; url?: string }[];
        };
    };

    const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]));
    const tweets = new Map((body.includes?.tweets ?? []).map((t) => [t.id, t]));
    const media = new Map((body.includes?.media ?? []).map((m) => [m.media_key, m]));
    const botLower = botHandle();

    const out: Mention[] = [];
    for (const t of body.data ?? []) {
        const u = users.get(t.author_id);
        if (!u) continue;

        // Reply target: the author of the replied-to tweet (the original poster).
        let opUser: XUser | null = null;
        const repliedTo = (t.referenced_tweets ?? []).find((r) => r.type === "replied_to");
        if (repliedTo) {
            const parent = tweets.get(repliedTo.id);
            const opRaw = parent ? users.get(parent.author_id) : undefined;
            // Ignore self-replies and replies to the bot itself.
            if (opRaw && opRaw.id !== u.id && opRaw.username.toLowerCase() !== botLower) {
                opUser = toXUser(opRaw);
            }
        }

        // First photo attachment, for the token logo.
        let imageUrl: string | null = null;
        for (const key of t.attachments?.media_keys ?? []) {
            const m = media.get(key);
            if (m?.type === "photo" && m.url) {
                imageUrl = m.url;
                break;
            }
        }

        out.push({ tweetId: t.id, text: t.text, author: toXUser(u), opUser, imageUrl });
    }
    return out;
}

/** Pin the tweet image + a metadata JSON; returns an ipfs:// URI or "". */
async function pinLaunchMetadata(
    imageUrl: string | null,
    name: string,
    symbol: string,
): Promise<string> {
    if (!imageUrl || !process.env.PINATA_JWT) return "";
    try {
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) return "";
        const buf = await imgRes.arrayBuffer();
        const { uri: imageUri } = await pinFile(new Uint8Array(buf), `${symbol}.jpg`);
        const { uri } = await pinJson({
            name,
            symbol,
            description: `Launched from a tweet via @${botHandle()} on Twitter.`,
            image: imageUri,
        });
        return uri;
    } catch {
        return ""; // image is best-effort; never block the launch on it
    }
}

export async function POST(req: NextRequest) {
    // Accept ANY configured cron secret, not just the highest-priority one.
    // The three share a fallback chain; when KEEPER_CRON_SECRET was introduced
    // the route started expecting only it, which 401'd the cron-job.org job that
    // still sends the older COMPOUNDER_CRON_SECRET (it worked for weeks, then
    // silently broke + got auto-disabled). Matching against all configured
    // secrets makes the job resilient to which one it was set up with.
    const secrets = [
        process.env.TWEET_LAUNCH_CRON_SECRET,
        process.env.KEEPER_CRON_SECRET,
        process.env.COMPOUNDER_CRON_SECRET,
    ].filter((s): s is string => !!s);
    if (secrets.length === 0) return NextResponse.json({ error: "cron secret not configured" }, { status: 500 });
    const auth = req.headers.get("authorization");
    // Constant-time match (audit LOW-2): the length check gates timingSafeEqual
    // (which throws on unequal lengths) and leaks nothing (fixed "Bearer " prefix +
    // fixed-width secret), avoiding the byte-by-byte short-circuit of `===`.
    const authed =
        !!auth &&
        secrets.some((s) => {
            const expected = `Bearer ${s}`;
            if (auth.length !== expected.length) return false;
            return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
        });
    if (!authed) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const bearer = process.env.X_BEARER_TOKEN;
    if (!bearer) return NextResponse.json({ ran: false, reason: "X_BEARER_TOKEN missing" }, { status: 503 });
    if (!isDbConfigured()) return NextResponse.json({ ran: false, reason: "DB not configured" }, { status: 503 });

    const operatorKey = process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY as Hex | undefined;
    if (!operatorKey || !/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) {
        return NextResponse.json({ ran: false, reason: "operator key missing/malformed" }, { status: 503 });
    }
    const hook = ADDRESSES.arcadeHook as Address;
    if (!hook || hook === "0x0000000000000000000000000000000000000000") {
        return NextResponse.json({ ran: false, reason: "hook address not configured" }, { status: 503 });
    }

    const account = privateKeyToAccount(operatorKey);
    const publicClient = createPublicClient({ chain: ARC_CHAIN, transport: http() });
    const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: http() });
    const criteria = criteriaFromEnv();
    const now = Date.now();
    const dayAgoIso = new Date(now - 86_400_000).toISOString();

    // This cron runs every minute; per-tick diagnostics are gated so they don't
    // flood Vercel Observability (billed per log event). Set TWEET_LAUNCH_DEBUG=1
    // to see them. Real actions (LAUNCHED / FAILED / X API error) always log.
    const dbg: (...a: unknown[]) => void =
        process.env.TWEET_LAUNCH_DEBUG === "1" ? console.log : () => {};

    dbg("[tweet-launch] config:", {
        botHandle: botHandle(),
        hook: hook.slice(0, 10),
        operator: account.address.slice(0, 10),
        criteria,
    });

    const summary = { scanned: 0, launched: 0, rejected: 0, skipped: 0, failed: 0, notes: [] as string[] };

    // X rejects a since_id older than ~7 days ("must be a tweet id created after
    // <now-7d>"). If the cron was paused past that window the stored cursor goes
    // stale and every poll 400s. Snowflake ids encode their creation time, so
    // drop a cursor older than 6 days and fetch recent instead; the run then
    // sets a fresh cursor and the idempotency layer (reserveTweet /
    // isTweetProcessed) prevents any re-launch.
    const storedSince = await getSinceId();
    let sinceId = storedSince;
    if (storedSince) {
        const createdMs = tweetIdToMs(storedSince);
        if (createdMs !== null && now - createdMs > 6 * 86_400_000) {
            dbg("[tweet-launch] since_id too old, dropping:", storedSince);
            sinceId = null;
        }
    }
    dbg("[tweet-launch] since_id:", sinceId ?? "(none)");
    let mentions: Mention[];
    try {
        mentions = await fetchLaunchMentions(bearer, sinceId);
    } catch (e) {
        console.error("[tweet-launch] X API error:", e);
        return NextResponse.json({ ran: false, reason: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
    summary.scanned = mentions.length;
    dbg("[tweet-launch] scanned:", mentions.length, "mentions:", mentions.map((m) => ({
        id: m.tweetId, author: m.author.username, followers: m.author.followers, text: m.text.slice(0, 80),
    })));

    // Process OLDEST-first and advance since_id only to the last tweet we actually
    // finished handling. If a per-run / global cap breaks the loop, the UNhandled
    // (newer) tweets are left BEHIND the cursor and re-fetched next run, instead of
    // being skipped forever (audit MEDIUM: the old newest-first + advance-past-all
    // dropped every tweet beyond the 5th, oldest-first).
    mentions.sort((a, b) => (BigInt(a.tweetId) < BigInt(b.tweetId) ? -1 : 1));
    let cursorId: string | null = sinceId;
    // Query the global count once + increment locally on each launch (cheaper
    // than a DB call per tweet).
    let globalCount = await globalLaunchCountSince(dayAgoIso);

    for (const m of mentions) {
        if (summary.launched >= MAX_LAUNCHES_PER_RUN) break;
        // Global circuit breaker (checked before committing the cursor so the
        // unhandled tweets stay behind it).
        if (globalCount >= GLOBAL_DAILY_LIMIT) {
            summary.notes.push("global daily limit reached");
            break;
        }
        // We are committing to handle this tweet (any outcome writes a row, so a
        // re-fetch is deduped): advance the cursor to it.
        cursorId = m.tweetId;
        try {
            if (await isTweetProcessed(m.tweetId)) {
                dbg(`[tweet-launch] skip ${m.tweetId}: already processed`);
                summary.skipped++;
                continue;
            }
            if (!hasLaunchIntent(m.text, botHandle())) {
                dbg(`[tweet-launch] skip ${m.tweetId}: no launch intent`);
                summary.skipped++;
                continue;
            }
            const cmd: LaunchCommand | null =
                (await parseLaunchWithClaude(m.text)) ?? parseLaunchCommand(m.text);
            if (!cmd) {
                dbg(`[tweet-launch] skip ${m.tweetId}: parse failed`);
                summary.skipped++;
                continue;
            }
            dbg(`[tweet-launch] parsed ${m.tweetId}: ${cmd.ticker} "${cmd.name}"`);
            const gate = passesCriteria(m.author, criteria, now);
            if (!gate.ok) {
                dbg(`[tweet-launch] reject ${m.tweetId}: ${gate.reason}`);
                summary.rejected++;
                await recordLaunchTweet({
                    tweetId: m.tweetId,
                    userId: m.author.id,
                    handle: m.author.username,
                    status: "rejected",
                    reason: gate.reason,
                });
                continue;
            }
            // Per-user rate limit (keyed on the numeric user-id).
            if ((await userLaunchCountSince(m.author.id, dayAgoIso)) >= PER_USER_DAILY_LIMIT) {
                summary.rejected++;
                await recordLaunchTweet({
                    tweetId: m.tweetId,
                    userId: m.author.id,
                    handle: m.author.username,
                    status: "rejected",
                    reason: "per-user daily limit",
                });
                continue;
            }

            // RESERVE the tweet BEFORE the on-chain spend. Closes the check-then-
            // act window: a crash or a concurrent run between the relay and the DB
            // write can no longer re-launch (the reserve is atomic; a loser skips).
            if (!(await reserveTweet(m.tweetId, m.author.id, m.author.username))) {
                summary.skipped++;
                continue;
            }

            // Token logo from the tweet image (best-effort).
            const metadataURI = await pinLaunchMetadata(m.imageUrl, cmd.name, cmd.ticker);

            // Reply-to-launch: route 50% of the creator fee to the FORWARDER
            // (creator2), which the claim-time reconciliation sweeps to the
            // original poster's escrow slot 1. creator2 must equal the forwarder
            // key's address (= hook.tokenForwarder) so ALL handle-launch
            // creator-side custody sits on one isolated key; falls back to the
            // operator (account) when FORWARDER_PRIVATE_KEY is unset (testnet).
            const isReply = m.opUser !== null;
            const creator2 = (forwarderAddress() ?? account.address) as `0x${string}`;
            const args = buildCreateLaunchArgs(cmd, m.author.username, {
                metadataURI,
                creator2: isReply ? creator2 : undefined,
                creator2Bps: isReply ? REPLY_SPLIT_BPS : 0,
            });

            const hash = await walletClient.writeContract({
                address: hook,
                abi: ARCADE_HOOK_ABI,
                functionName: "createLaunch",
                args,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            let token: string | undefined;
            let poolId: string | undefined;
            for (const log of receipt.logs) {
                if ((log.address as string).toLowerCase() !== hook.toLowerCase()) continue;
                try {
                    const dec = decodeEventLog({ abi: ARCADE_HOOK_ABI, data: log.data, topics: log.topics });
                    if (dec.eventName === "TokenLaunched") token = (dec.args as { token: string }).token;
                    if (dec.eventName === "LaunchCreated") poolId = (dec.args as { poolId: string }).poolId;
                } catch {
                    /* not our event */
                }
            }

            await recordLaunchTweet({
                tweetId: m.tweetId,
                userId: m.author.id,
                handle: m.author.username,
                status: "launched",
                token,
                poolId,
                txHash: hash,
                isReply,
                opUserId: m.opUser?.id,
                opHandle: m.opUser?.username,
            });
            summary.launched++;
            globalCount++;
            console.log(`[tweet-launch] LAUNCHED ${m.tweetId}: token=${token} tx=${hash}`);

            if (token) {
                await postLaunchReply(m.tweetId, token, cmd.name, cmd.ticker, m.opUser?.username).catch(() => false);
            }
        } catch (err) {
            summary.failed++;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[tweet-launch] FAILED ${m.tweetId}: ${msg.slice(0, 200)}`);
            summary.notes.push(`tweet=${m.tweetId} error=${msg.slice(0, 160)}`);
            await recordLaunchTweet({
                tweetId: m.tweetId,
                userId: m.author.id,
                handle: m.author.username,
                status: "failed",
                reason: msg.slice(0, 200),
            }).catch(() => {});
        }
    }

    // Persist the cursor: the last tweet we finished handling (unhandled newer
    // ones stay behind it and re-fetch next run). Reserve/idempotency dedupes.
    if (cursorId && cursorId !== sinceId) await setSinceId(cursorId);

    // Q6 safety net (piggyback): re-deliver any token-side a claim's client POST
    // missed, on this cron's existing trigger. Best-effort + idempotent; the
    // recipient is bound to the on-chain Claimed event, so it can only pay the real
    // claimant. Never fail the tweet cron on a delivery error.
    let tokenDelivery: Awaited<ReturnType<typeof deliverPendingTokenSides>> | { ran: false; reason: string };
    try {
        tokenDelivery = await deliverPendingTokenSides();
    } catch (e) {
        tokenDelivery = { ran: false, reason: e instanceof Error ? e.message : String(e) };
    }

    dbg("[tweet-launch] done:", summary);
    return NextResponse.json({ ran: true, sinceId: sinceId ?? null, ...summary, tokenDelivery });
}
