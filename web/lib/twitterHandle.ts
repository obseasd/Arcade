/**
 * Canonicalise a Twitter/X @handle for safe comparison against on-chain / stored
 * attribution. Shared by the OAuth callback (V3 path) and the V4 claim path so
 * both gate identical bytes.
 *
 *  1) NFKC normalise (folds compatibility variants)
 *  2) Strip zero-width chars (ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, BOM U+FEFF)
 *  3) Lowercase + trim, drop a leading @
 *  4) Validate against Twitter's strict set ^[a-z0-9_]{1,15}$
 *
 * Returns the cleaned handle, or undefined when validation fails (Cyrillic
 * homoglyph, emoji injection, leading dot, over-length, etc.) so the signing
 * flow refuses to proceed.
 */
export function normaliseHandle(raw: string | undefined | null): string | undefined {
    if (typeof raw !== "string") return undefined;
    let h = raw.normalize("NFKC");
    h = h.replace(/[​-‍﻿]/g, "");
    h = h.toLowerCase().trim();
    if (h.startsWith("@")) h = h.slice(1);
    if (!/^[a-z0-9_]{1,15}$/.test(h)) return undefined;
    return h;
}
