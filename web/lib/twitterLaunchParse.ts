/**
 * Natural-language launch-command parsing for tweet-to-launch, via Claude Haiku
 * 4.5 (like Clanker's Claude-based cast parser). A cheap regex pre-filter runs
 * FIRST (see hasLaunchIntent) so Claude is only ever called on real candidates,
 * keeping cost at ~$0.001/parse and total spend proportional to actual launch
 * attempts, not total mentions.
 *
 * SECURITY: the model is instructed to REFUSE anything that isn't an
 * unambiguous launch command (returns isLaunch:false). This is the guard against
 * the Grok/Bankr failure mode where a bot minted tokens off misread replies. We
 * also hard-validate ticker/name shape after the model returns.
 */

/** Cheap, free pre-filter: must mention the bot AND contain a launch verb.
 *  Only tweets passing this are worth a paid Claude parse. */
export function hasLaunchIntent(text: string, botHandleLower: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (!lower.includes(`@${botHandleLower}`)) return false;
    return /\b(launch|deploy|create|mint)\b/i.test(text);
}

export interface ParsedLaunch {
    /** ERC-20 name, <= 32 chars. */
    name: string;
    /** ERC-20 ticker, uppercase alphanumeric, <= 12 chars. */
    ticker: string;
}

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You extract a token launch command from a single tweet that mentions a launchpad bot.
Return ONLY a compact JSON object, no prose, no markdown fences.

If the tweet is an unambiguous request to launch/deploy/create a token, return:
{"isLaunch": true, "name": "<token name>", "ticker": "<TICKER>"}

Rules:
- ticker: 1-12 chars, letters/digits only, UPPERCASE, no $ or spaces. If the user wrote $ABC, ticker is ABC.
- name: the human token name, <= 32 chars. If only a ticker is given, use the ticker as the name.
- Strip @mentions, URLs, and hashtags from the name.
- If the tweet is NOT clearly a launch request (just chatter, a question, praise, a reply with no token intent), return {"isLaunch": false}.
- When in doubt, return {"isLaunch": false}. Never guess a token into existence.`;

/**
 * Parse a tweet with Claude. Returns the launch params, or null if it is not a
 * launch command (or the API is unavailable / the output fails validation).
 * Requires ANTHROPIC_API_KEY; returns null (skip) when unset so the cron
 * degrades safely instead of throwing.
 */
export async function parseLaunchWithClaude(text: string): Promise<ParsedLaunch | null> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;

    let res: Response;
    try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 128,
                system: SYSTEM_PROMPT,
                messages: [{ role: "user", content: text.slice(0, 1000) }],
            }),
        });
    } catch {
        return null; // network error -> skip this tweet, retry next poll
    }
    if (!res.ok) return null;

    let body: { content?: { type: string; text?: string }[] };
    try {
        body = (await res.json()) as typeof body;
    } catch {
        return null;
    }
    const raw = (body.content ?? []).find((b) => b.type === "text")?.text ?? "";
    return validateParsed(raw);
}

/** Parse + hard-validate the model's JSON. Exported for unit tests. */
export function validateParsed(raw: string): ParsedLaunch | null {
    // Tolerate accidental ```json fences or leading prose.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    let obj: { isLaunch?: unknown; name?: unknown; ticker?: unknown };
    try {
        obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return null;
    }
    if (obj.isLaunch !== true) return null;

    const rawTicker = typeof obj.ticker === "string" ? obj.ticker : "";
    const ticker = rawTicker.replace(/^\$/, "").toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(ticker)) return null;

    let name = typeof obj.name === "string" ? obj.name : "";
    name = name
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[@#]\w+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 32);
    if (!name) name = ticker;

    return { name, ticker };
}
