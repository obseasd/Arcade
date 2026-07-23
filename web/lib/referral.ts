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

import { arcTestnet } from "@/lib/chains";

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
 *  backend is idempotent + first-touch, so calling this repeatedly is safe.
 *  Records an UNVERIFIED row: display only, never payable. */
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

/** EIP-712 payload for the proof. MUST stay byte-identical to
 *  verifyRegisterSignature in lib/referralPayout.ts: any drift in the domain,
 *  the type list, or the field ORDER silently yields a signature that recovers
 *  to the wrong address, which the route then rejects as forged. */
export const REGISTER_DOMAIN = {
    name: "ArcadeReferral",
    version: "1",
    // Imported, never re-typed: verifyRegisterSignature builds its domain from
    // this same chain object, and a hardcoded copy here would drift the day the
    // chain id changes (mainnet) and reject every signature with no error worth
    // reading.
    chainId: arcTestnet.id,
} as const;
export const REGISTER_TYPES = {
    Register: [
        { name: "referred", type: "address" },
        { name: "referrer", type: "address" },
        { name: "deadline", type: "uint256" },
    ],
} as const;

/** The signature is valid for an hour; the verifier caps how far ahead a
 *  deadline may sit, so this must stay under MAX_DEADLINE_SECONDS. */
const REGISTER_DEADLINE_SECONDS = 3600;

type SignTypedData = (args: {
    domain: typeof REGISTER_DOMAIN;
    types: typeof REGISTER_TYPES;
    primaryType: "Register";
    message: { referred: `0x${string}`; referrer: `0x${string}`; deadline: bigint };
}) => Promise<string>;

const verifiedKey = (account: string) => `${STORAGE_KEY}.verified.${account.toLowerCase()}`;

/** True once this wallet has proven (or declined) its referral, so we ask at
 *  most once per wallet instead of nagging on every connect. */
export function hasSettledReferralProof(account: string): boolean {
    if (typeof window === "undefined") return true;
    try {
        return localStorage.getItem(verifiedKey(account)) !== null;
    } catch {
        return true; // no storage -> never nag
    }
}

function settleReferralProof(account: string, outcome: "verified" | "declined"): void {
    try {
        localStorage.setItem(verifiedKey(account), outcome);
    } catch {
        /* ignore */
    }
}

/**
 * Upgrade the stored referral from a CLAIM to a PROOF.
 *
 * /api/referral/register is unauthenticated and the caller names BOTH
 * addresses, so an unsigned row asserts "I referred this wallet" and anyone can
 * assert it about anyone. Only the REFERRED wallet can produce this signature,
 * which is why it is the only tier that is ever paid or counted.
 *
 * WHY THIS EXISTS: the server side of this tier shipped without its client.
 * verifyRegisterSignature and the route's `verified` branch were written, but
 * nothing ever SIGNED, so `verified` was false for every row in existence and
 * the entire proven tier -- payouts, headline stats, the override -- was dead
 * code sitting behind a condition that could not occur.
 *
 * Costs the user nothing: no gas, no transaction, one popup. Runs AFTER the
 * unverified registration and never blocks it, so declining leaves today's
 * behaviour intact rather than losing the attribution.
 */
export async function proveStoredReferral(
    account: string,
    signTypedData: SignTypedData,
): Promise<boolean> {
    const referrer = getStoredReferrer();
    if (!referrer || !isAddr(account)) return false;
    if (referrer === account.toLowerCase()) return false;
    if (hasSettledReferralProof(account)) return false;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + REGISTER_DEADLINE_SECONDS);
    let signature: string;
    try {
        signature = await signTypedData({
            domain: REGISTER_DOMAIN,
            types: REGISTER_TYPES,
            primaryType: "Register",
            message: {
                referred: account as `0x${string}`,
                referrer: referrer as `0x${string}`,
                deadline,
            },
        });
    } catch {
        // Rejected the popup, or the wallet cannot sign typed data. Not an
        // error: the unverified row already stands. Remember the refusal so we
        // ask once, not on every reconnect.
        settleReferralProof(account, "declined");
        return false;
    }

    try {
        const res = await fetch("/api/referral/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                referred: account,
                referrer,
                deadline: deadline.toString(),
                signature,
            }),
        });
        const data = (await res.json()) as { verified?: boolean };
        if (res.ok && data.verified) {
            settleReferralProof(account, "verified");
            return true;
        }
    } catch {
        /* leave unsettled so a later connect retries */
    }
    return false;
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

/** Local record that this wallet ANCHORED its referrer on-chain (the Memo tx).
 *  Re-deriving this from chain on every page load would need the multi-window
 *  getLogs scan, so we remember it locally; without it the "Confirm on-chain"
 *  button reset on every refresh and looked like nothing had been saved.
 *  DISPLAY ONLY - the payout path independently verifies the Memo attribution
 *  on-chain, so a forged flag here can never move money. */
const anchoredKey = (referred: string, referrer: string) =>
    `${STORAGE_KEY}.anchored.${referred.toLowerCase()}.${referrer.toLowerCase()}`;

export function markReferralAnchored(referred: string, referrer: string): void {
    try {
        localStorage.setItem(anchoredKey(referred, referrer), "1");
    } catch {
        /* no storage -> the button simply resets on refresh */
    }
}

export function isReferralAnchored(referred: string, referrer: string): boolean {
    try {
        return localStorage.getItem(anchoredKey(referred, referrer)) === "1";
    } catch {
        return false;
    }
}
