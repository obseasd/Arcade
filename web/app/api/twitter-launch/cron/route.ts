import { NextRequest, NextResponse } from "next/server";
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

const ARC_CHAIN = {
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
} as const;

const MAX_LAUNCHES_PER_RUN = 5;
const PER_USER_DAILY_LIMIT = Number(process.env.TWEET_LAUNCH_PER_USER_DAILY ?? "1");
// Circuit breaker: a hard global ceiling on sponsored launches per 24h so a sybil
// fleet can't drain the operator's gas + 3-USDC-per-launch sponsorship.
const GLOBAL_DAILY_LIMIT = Number(process.env.TWEET_LAUNCH_GLOBAL_DAILY ?? "50");

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
    const secret =
        process.env.TWEET_LAUNCH_CRON_SECRET ??
        process.env.KEEPER_CRON_SECRET ??
        process.env.COMPOUNDER_CRON_SECRET;
    if (!secret) return NextResponse.json({ error: "cron secret not configured" }, { status: 500 });
    if (req.headers.get("authorization") !== `Bearer ${secret}`) {
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

    const summary = { scanned: 0, launched: 0, rejected: 0, skipped: 0, failed: 0, notes: [] as string[] };

    const sinceId = await getSinceId();
    let mentions: Mention[];
    try {
        mentions = await fetchLaunchMentions(bearer, sinceId);
    } catch (e) {
        return NextResponse.json({ ran: false, reason: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
    summary.scanned = mentions.length;

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
                summary.skipped++;
                continue;
            }
            // Cheap free pre-filter before any paid Claude call.
            if (!hasLaunchIntent(m.text, botHandle())) {
                summary.skipped++;
                continue;
            }
            // NL parse via Claude, falling back to the strict regex parser when
            // ANTHROPIC_API_KEY is unset or Claude is unavailable.
            const cmd: LaunchCommand | null =
                (await parseLaunchWithClaude(m.text)) ?? parseLaunchCommand(m.text);
            if (!cmd) {
                summary.skipped++;
                continue;
            }
            // Automated anti-sybil gate.
            const gate = passesCriteria(m.author, criteria, now);
            if (!gate.ok) {
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

            // Reply-to-launch: route 50% of the creator fee to the operator,
            // which the claim-time reconciliation forwards to the original
            // poster's escrow slot 1.
            const isReply = m.opUser !== null;
            const args = buildCreateLaunchArgs(cmd, m.author.username, {
                metadataURI,
                creator2: isReply ? (account.address as `0x${string}`) : undefined,
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

            // Announce the launch: reply to the tweet as the bot with the Arcade
            // link. Best-effort (needs the OAuth 1.0a write creds); never blocks.
            if (token) {
                await postLaunchReply(m.tweetId, token, cmd.name, cmd.ticker).catch(() => false);
            }
        } catch (err) {
            summary.failed++;
            const msg = err instanceof Error ? err.message : String(err);
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

    return NextResponse.json({ ran: true, ...summary });
}
