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
    type XUser,
    type CriteriaConfig,
} from "@/lib/twitterLaunch";
import {
    isTweetProcessed,
    recordLaunchTweet,
    userLaunchCountSince,
} from "@/lib/twitterLaunchPersistence";
import { isDbConfigured } from "@/lib/db";

/**
 * Tweet-to-launch cron. Reads recent mentions of the bot, validates each author
 * against automated anti-sybil criteria, and RELAYS a CLANKER createLaunch on
 * their behalf (the operator wallet sponsors gas + the 3 USDC creation fee).
 * Creator fees attribute to the author's handle via the escrow; the canonical
 * binding stored in the DB is the numeric user-id.
 *
 * Requires: X_BEARER_TOKEN (X API v2 app-only), COMPOUNDER_OPERATOR_PRIVATE_KEY
 * (relayer, funded + USDC-approved to the hook + escrow.setCrediter(hook) +
 * hook.setTwitterEscrow(escrow) done), KEEPER_CRON_SECRET, the twitter_launches
 * table, and NEXT_PUBLIC_ARCADE_HOOK_ADDRESS. Curated by CRITERIA env below.
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
}

/** Fetch recent bot mentions containing "launch", with author profiles. */
async function fetchLaunchMentions(bearer: string): Promise<Mention[]> {
    const query = encodeURIComponent(`@${botHandle()} launch -is:retweet`);
    const url =
        `https://api.twitter.com/2/tweets/search/recent?query=${query}` +
        `&max_results=20&tweet.fields=author_id,created_at` +
        `&expansions=author_id&user.fields=created_at,public_metrics,verified,username`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
        data?: { id: string; text: string; author_id: string }[];
        includes?: {
            users?: {
                id: string;
                username: string;
                created_at: string;
                verified?: boolean;
                public_metrics?: { followers_count: number };
            }[];
        };
    };
    const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]));
    const out: Mention[] = [];
    for (const t of body.data ?? []) {
        const u = users.get(t.author_id);
        if (!u) continue;
        out.push({
            tweetId: t.id,
            text: t.text,
            author: {
                id: u.id,
                username: u.username,
                createdAt: u.created_at,
                followers: u.public_metrics?.followers_count ?? 0,
                verified: u.verified,
            },
        });
    }
    return out;
}

export async function POST(req: NextRequest) {
    // Dedicated secret first (so you can set a fresh TWEET_LAUNCH_CRON_SECRET
    // you control without touching the keeper/compounder crons), then fallbacks.
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

    let mentions: Mention[];
    try {
        mentions = await fetchLaunchMentions(bearer);
    } catch (e) {
        return NextResponse.json({ ran: false, reason: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
    summary.scanned = mentions.length;

    for (const m of mentions) {
        if (summary.launched >= MAX_LAUNCHES_PER_RUN) break;
        try {
            if (await isTweetProcessed(m.tweetId)) {
                summary.skipped++;
                continue;
            }
            const cmd = parseLaunchCommand(m.text);
            if (!cmd) {
                summary.skipped++;
                continue; // not a launch command; don't record (avoids table bloat from chatter)
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

            // Relay the CLANKER launch (operator sponsors gas + creation fee).
            const args = buildCreateLaunchArgs(cmd, m.author.username);
            const hash = await walletClient.writeContract({
                address: hook,
                abi: ARCADE_HOOK_ABI,
                functionName: "createLaunch",
                args,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            // Pull the new token + pool id from the events.
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
            });
            summary.launched++;
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

    return NextResponse.json({ ran: true, ...summary });
}
