/**
 * Token social links: validation + normalization, shared by the create form
 * (filters invalid input before it is written into the on-chain metadata) and
 * the launchpad cards / detail page (renders the icon row).
 *
 * Every `normalizeSocial` accepts a full URL, a bare username, or an @handle and
 * returns a canonical https URL, or `null` when the input is invalid (so callers
 * can drop it -- "Invalid links will be filtered out").
 */

export type SocialKey = "twitter" | "telegram" | "discord" | "website" | "farcaster";

/** The 5 platforms, in display order, with the create-form field metadata. */
export const SOCIAL_FIELDS: {
    key: SocialKey;
    label: string;
    placeholder: string;
}[] = [
    { key: "twitter", label: "Twitter / X", placeholder: "@username or x.com/username" },
    { key: "telegram", label: "Telegram", placeholder: "@username or t.me/username" },
    { key: "discord", label: "Discord", placeholder: "discord.gg/invite" },
    { key: "website", label: "Website", placeholder: "example.com" },
    { key: "farcaster", label: "Farcaster", placeholder: "@username" },
];

const stripAt = (s: string) => s.replace(/^@+/, "").trim();
const hasProto = (s: string) => /^https?:\/\//i.test(s);

/**
 * Normalize one social input to a canonical https URL, or null if invalid.
 * Never throws.
 */
export function normalizeSocial(key: SocialKey, raw: string): string | null {
    const v = (raw || "").trim();
    if (!v) return null;
    try {
        switch (key) {
            case "twitter": {
                if (hasProto(v)) {
                    const u = new URL(v);
                    if (!/(^|\.)(x\.com|twitter\.com)$/i.test(u.hostname)) return null;
                    const h = stripAt(u.pathname.replace(/^\/+/, "").split("/")[0]);
                    return /^[A-Za-z0-9_]{1,15}$/.test(h) ? `https://x.com/${h}` : null;
                }
                const h = stripAt(v.replace(/^(?:www\.)?(?:x\.com|twitter\.com)\//i, ""));
                return /^[A-Za-z0-9_]{1,15}$/.test(h) ? `https://x.com/${h}` : null;
            }
            case "telegram": {
                if (hasProto(v)) {
                    const u = new URL(v);
                    if (!/(^|\.)t\.me$/i.test(u.hostname)) return null;
                    const h = u.pathname.replace(/^\/+/, "").split("/")[0];
                    return /^[A-Za-z0-9_]{3,32}$/.test(h) ? `https://t.me/${h}` : null;
                }
                const h = stripAt(v.replace(/^(?:www\.)?t\.me\//i, ""));
                return /^[A-Za-z0-9_]{3,32}$/.test(h) ? `https://t.me/${h}` : null;
            }
            case "discord": {
                const m = v.match(
                    /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite)\/([A-Za-z0-9-]{2,32})/i,
                );
                if (m) return `https://discord.gg/${m[1]}`;
                return /^[A-Za-z0-9-]{2,32}$/.test(v) ? `https://discord.gg/${v}` : null;
            }
            case "website": {
                const u = new URL(hasProto(v) ? v : `https://${v}`);
                // Require a dotted host and a web scheme; reject junk like "http://x".
                if (!/^https?:$/i.test(u.protocol) || !u.hostname.includes(".")) return null;
                return u.toString();
            }
            case "farcaster": {
                if (hasProto(v)) {
                    const u = new URL(v);
                    if (!/(^|\.)(warpcast\.com|farcaster\.xyz)$/i.test(u.hostname)) return null;
                    const h = stripAt(u.pathname.replace(/^\/+/, "").split("/")[0]);
                    return /^[A-Za-z0-9_.-]{1,32}$/.test(h) ? `https://warpcast.com/${h}` : null;
                }
                const h = stripAt(v.replace(/^(?:www\.)?(?:warpcast\.com|farcaster\.xyz)\//i, ""));
                return /^[A-Za-z0-9_.-]{1,32}$/.test(h) ? `https://warpcast.com/${h}` : null;
            }
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Take the 5 raw create-form inputs and return only the valid, normalized ones
 * as a partial metadata object (invalid entries are dropped).
 */
export function buildSocialsForMetadata(
    raw: Partial<Record<SocialKey, string>>,
): Partial<Record<SocialKey, string>> {
    const out: Partial<Record<SocialKey, string>> = {};
    for (const { key } of SOCIAL_FIELDS) {
        const url = normalizeSocial(key, raw[key] ?? "");
        if (url) out[key] = url;
    }
    return out;
}
