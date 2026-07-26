import { NextRequest, NextResponse } from "next/server";
import { getLaunchByPool, getReplyLaunchByPool } from "@/lib/twitterLaunchPersistence";

/**
 * GET /api/twitter-launch/reply?poolId=0x<64 hex>
 *
 * Public read of a reply-launch's fee beneficiaries so the token page can show
 * BOTH @handles that share the creator fee (launcher on escrow slot 0, replied-to
 * original poster on slot 1). The 50/50 split itself lives on-chain in the
 * FeeOwner (creator2Bps); this only resolves the two user-ids to display @handles,
 * which are already public (the launch tweet + the bot's reply announce them).
 * Returns { launcherHandle, opHandle } with nulls when a leg isn't a recorded
 * tweet-launch. No auth: handles are display metadata, and the actual claim still
 * requires OAuth proof + the trusted-signer signature.
 */
export async function GET(req: NextRequest) {
    const raw = req.nextUrl.searchParams.get("poolId");
    if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        return NextResponse.json({ error: "bad poolId" }, { status: 400 });
    }
    const poolId = raw.toLowerCase();
    const [launcher, reply] = await Promise.all([
        getLaunchByPool(poolId).catch(() => null),
        getReplyLaunchByPool(poolId).catch(() => null),
    ]);
    return NextResponse.json(
        {
            launcherHandle: launcher?.handle ?? null,
            opHandle: reply?.opHandle ?? null,
        },
        { headers: { "cache-control": "public, max-age=30" } },
    );
}
