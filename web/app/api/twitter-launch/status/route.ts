import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getSql } from "@/lib/db";
import { getSinceId } from "@/lib/twitterLaunchPersistence";
import { botHandle } from "@/lib/twitterLaunch";
import { ADDRESSES } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const secret =
        process.env.TWEET_LAUNCH_CRON_SECRET ??
        process.env.KEEPER_CRON_SECRET ??
        process.env.COMPOUNDER_CRON_SECRET;
    if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const config = {
        botHandle: botHandle(),
        hook: (ADDRESSES.arcadeHook ?? "").slice(0, 12) + "...",
        hasXBearer: !!process.env.X_BEARER_TOKEN,
        hasOperatorKey: /^0x[0-9a-fA-F]{64}$/.test(process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY ?? ""),
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        hasPinataJwt: !!process.env.PINATA_JWT,
        dbConfigured: isDbConfigured(),
        minFollowers: Number(process.env.TWEET_LAUNCH_MIN_FOLLOWERS ?? 100),
        minAccountAgeDays: Number(process.env.TWEET_LAUNCH_MIN_ACCOUNT_AGE_DAYS ?? 30),
        perUserDaily: Number(process.env.TWEET_LAUNCH_PER_USER_DAILY ?? 1),
    };

    let sinceId: string | null = null;
    let recentLaunches: unknown = [];
    if (isDbConfigured()) {
        sinceId = await getSinceId();
        const sql = getSql();
        recentLaunches = await sql`
            SELECT tweet_id, handle, status, reason, token, tx_hash, created_at
            FROM twitter_launches
            ORDER BY created_at DESC
            LIMIT 20
        `;
    }

    return NextResponse.json({ config, sinceId, recentLaunches });
}
