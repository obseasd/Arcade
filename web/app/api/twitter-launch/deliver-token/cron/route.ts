import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

import { deliverPendingTokenSides } from "@/lib/twitterTokenDeliver";

/**
 * Q6 token-delivery safety net (dedicated cron trigger). Re-delivers the TOKEN side
 * of tweet/reply-to-launch creator fees to claimants whose client-side forward POST
 * failed, before the 180-day stale-sweep would forfeit it to the treasury. The core
 * (deliverPendingTokenSides) is shared with the tweet-reader cron so it also runs on
 * that trigger; this route lets an operator schedule it on its own cadence. It can
 * ONLY pay the wallet that actually claimed (recipient read from the on-chain Claimed
 * event) and is idempotent, so it adds no theft/double-pay surface.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
    // Auth: a dedicated KEEPER_CRON_SECRET (preferred) or the shared
    // COMPOUNDER_CRON_SECRET, constant-time matched (same gate as the keeper cron).
    const secrets = [process.env.KEEPER_CRON_SECRET, process.env.COMPOUNDER_CRON_SECRET].filter(
        (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (secrets.length === 0) {
        return NextResponse.json(
            { error: "KEEPER_CRON_SECRET (or COMPOUNDER_CRON_SECRET) not configured" },
            { status: 500 },
        );
    }
    const auth = req.headers.get("authorization");
    const ok =
        !!auth &&
        secrets.some((s) => {
            const expected = `Bearer ${s}`;
            if (auth.length !== expected.length) return false;
            return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
        });
    if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const result = await deliverPendingTokenSides();
    return NextResponse.json(result);
}
