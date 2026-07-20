import crypto from "crypto";

/**
 * Post a reply from the bot account (@ArcadeSwap) to a launch tweet, announcing
 * the token is live with its Arcade link. Best-effort: returns false (never
 * throws) so a failed reply can't break the launch flow.
 *
 * Posting a tweet needs USER-context write auth, not the app-only read bearer.
 * We use OAuth 1.0a (static consumer + access credentials, no refresh dance),
 * signing POST https://api.twitter.com/2/tweets. Requires four envs, all from
 * the bot account's app (Keys & Tokens): X_CONSUMER_KEY, X_CONSUMER_SECRET,
 * X_ACCESS_TOKEN, X_ACCESS_SECRET. The access token must be generated while the
 * app is authorised by the BOT account (@ArcadeSwap), so the reply comes from it.
 */

const APP_ORIGIN = "https://www.arcade.trading";

function writeCreds():
    | { consumerKey: string; consumerSecret: string; accessToken: string; accessSecret: string }
    | null {
    const consumerKey = process.env.X_CONSUMER_KEY;
    const consumerSecret = process.env.X_CONSUMER_SECRET;
    const accessToken = process.env.X_ACCESS_TOKEN;
    const accessSecret = process.env.X_ACCESS_SECRET;
    if (!consumerKey || !consumerSecret || !accessToken || !accessSecret) return null;
    return { consumerKey, consumerSecret, accessToken, accessSecret };
}

/** RFC-3986 percent-encoding (stricter than encodeURIComponent). */
function pct(s: string): string {
    return encodeURIComponent(s).replace(
        /[!*'()]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
}

/** Build the OAuth 1.0a Authorization header for a JSON-body POST (the JSON body
 *  is NOT part of the signature base string, per the spec for non-form bodies). */
function oauthHeader(
    url: string,
    creds: NonNullable<ReturnType<typeof writeCreds>>,
): string {
    const oauth: Record<string, string> = {
        oauth_consumer_key: creds.consumerKey,
        oauth_nonce: crypto.randomBytes(16).toString("hex"),
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: creds.accessToken,
        oauth_version: "1.0",
    };
    const paramString = Object.keys(oauth)
        .sort()
        .map((k) => `${pct(k)}=${pct(oauth[k])}`)
        .join("&");
    const baseString = ["POST", pct(url), pct(paramString)].join("&");
    const signingKey = `${pct(creds.consumerSecret)}&${pct(creds.accessSecret)}`;
    const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
    oauth.oauth_signature = signature;
    return (
        "OAuth " +
        Object.keys(oauth)
            .sort()
            .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
            .join(", ")
    );
}

/**
 * Reply to `tweetId` announcing the launch. Returns true on a 2xx post.
 */
export async function postLaunchReply(
    tweetId: string,
    token: string,
    name: string,
    ticker: string,
    opHandle?: string,
): Promise<boolean> {
    const creds = writeCreds();
    if (!creds) return false; // write creds not configured -> skip silently

    const link = `${APP_ORIGIN}/launchpad/v4hook/${token}`;
    let text = `${link}\n\n${name} (${ticker}) is live on Arc. Trade it live on Arcade`;
    // Reply-to-launch: tell the original poster they earn 50% + give them a
    // slot-1 claim link (the only surface that reaches the OP's escrow share).
    if (opHandle) {
        const h = opHandle.replace(/^@/, "");
        text += `\n\n@${h} you earn 50% of the creator fees — claim: ${APP_ORIGIN}/claim?token=${token}&slot=1&handle=${h}`;
    }
    const url = "https://api.twitter.com/2/tweets";

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                Authorization: oauthHeader(url, creds),
            },
            body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: tweetId } }),
        });
        return res.ok;
    } catch {
        return false;
    }
}
