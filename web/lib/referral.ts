"use client";

/**
 * Referral client helpers (Phase 1).
 *
 * Flow:
 *   1. A user shares buildReferralLink(theirAddress) → arcade.trading/?ref=0xA.
 *   2. A new visitor lands with ?ref=0xA → captureReferralFromUrl() stores it
 *      in localStorage, FIRST-TOUCH (never overwritten).
 *   3. On wallet connect, registerStoredReferral(account) POSTs the
 *      (referred=account, referrer=stored) pair to the backend, which keeps
 *      the first referrer forever.
 *   4. On each confirmed trade, reportReferralTrade(account, volumeUsdMicros)
 *      accrues volume + the referrer's 10% share.
 *
 * Nothing here touches the swap path — reportReferralTrade is a
 * fire-and-forget call from a trade's SUCCESS handler.
 */

const STORAGE_KEY = "arcade.referrer";
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

/** Read ?ref= from the current URL and store it first-touch. Returns the
 *  stored referrer (existing or freshly captured), or null. */
export function captureReferralFromUrl(): string | null {
    if (typeof window === "undefined") return null;
    const existing = getStoredReferrer();
    try {
        const ref = new URLSearchParams(window.location.search).get("ref");
        if (ref && isAddr(ref) && !existing) {
            localStorage.setItem(STORAGE_KEY, ref.trim().toLowerCase());
            return ref.trim().toLowerCase();
        }
    } catch {
        /* ignore */
    }
    return existing;
}

export function getStoredReferrer(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v && isAddr(v) ? v : null;
    } catch {
        return null;
    }
}

/** POST the stored referrer for `account` once (skips self-referral). The
 *  backend is idempotent + first-touch, so calling this repeatedly is safe. */
export async function registerStoredReferral(account: string): Promise<void> {
    const referrer = getStoredReferrer();
    if (!referrer || !isAddr(account)) return;
    if (referrer === account.toLowerCase()) return; // can't refer yourself
    try {
        await fetch("/api/referral/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ referred: account, referrer }),
        });
    } catch {
        /* fire-and-forget */
    }
}

/** Fire-and-forget: accrue a confirmed trade against the trader's referrer. */
export function reportReferralTrade(account: string, volumeUsdMicros: bigint): void {
    if (!isAddr(account) || volumeUsdMicros <= 0n) return;
    try {
        void fetch("/api/referral/track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                trader: account,
                volumeUsdMicros: volumeUsdMicros.toString(),
            }),
            keepalive: true,
        });
    } catch {
        /* fire-and-forget */
    }
}

/** The shareable referral link for `account`. */
export function buildReferralLink(account: string): string {
    const origin =
        typeof window !== "undefined" ? window.location.origin : "https://www.arcade.trading";
    return `${origin}/?ref=${account}`;
}
