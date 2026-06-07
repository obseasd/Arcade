/**
 * localStorage persistence for in-flight Twitter escrow claims.
 *
 * The two-step `authorize` + `claimByTwitter` flow has a timelock (1h
 * default, up to 7d) between the two. Without persistence the user would
 * lose the URL params after the authorize tx and have no way back to the
 * claim form for THAT specific nonce. Re-OAuthing would mint a fresh
 * signature whose nonce collides with the in-flight pending (SlotPending
 * on authorize) - so they'd be stuck until the original nonce's deadline
 * expires.
 *
 * We snapshot the params after a successful authorize, keyed by the user
 * wallet, and surface a "Resume claim" banner on the token detail page +
 * /my-tokens. When `executeAfter` is reached the banner promotes itself
 * to a "Finish claim" button that re-routes to /claim with the stored
 * params; the existing flow there sweeps the slot.
 */

import { isAddress, type Address } from "viem";

const STORAGE_KEY_PREFIX = "arcade:pending-twitter-claim:";

/**
 * FSEC-006: localStorage entries are trusted on the same origin, but if a
 * separate XSS ever lands the attacker could write a hostile entry that
 * the /claim page would route to. This schema check rejects entries that
 * don't look like the shape we wrote, so a stray field can't redirect
 * the EIP-712 sig to an attacker-controlled recipient.
 *
 * Same defense is applied in bridgeHistory.ts and activityFeed.ts.
 */
function isValidPendingClaim(x: unknown): x is PendingTwitterClaim {
    if (!x || typeof x !== "object") return false;
    const v = x as Record<string, unknown>;
    return (
        typeof v.account === "string" && isAddress(v.account) &&
        typeof v.token === "string" && isAddress(v.token) &&
        typeof v.positionId === "string" &&
        typeof v.slotIndex === "string" &&
        typeof v.recipient === "string" && isAddress(v.recipient) &&
        typeof v.pairedToken === "string" && isAddress(v.pairedToken) &&
        typeof v.pairedAmount === "string" &&
        typeof v.clankerToken === "string" && isAddress(v.clankerToken) &&
        typeof v.clankerAmount === "string" &&
        typeof v.deadline === "string" &&
        typeof v.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(v.nonce) &&
        typeof v.sig === "string" && /^0x[0-9a-fA-F]+$/.test(v.sig) &&
        typeof v.executeAfter === "number" &&
        typeof v.handle === "string" &&
        typeof v.savedAt === "number"
    );
}

export interface PendingTwitterClaim {
    /** Wallet that initiated the authorize. */
    account: Address;
    /** Token address (the launched ERC20). */
    token: Address;
    /** V3 locker position id. */
    positionId: string;
    /** Slot index inside the position. */
    slotIndex: string;
    /** Recipient signed into the EIP-712 claim. Always paid to this address. */
    recipient: Address;
    /** Paired token address (USDC or WETH). */
    pairedToken: Address;
    /** Signed paired amount (acts as a minimum at claim time). */
    pairedAmount: string;
    /** Launch token address (= `token` typically but kept separate for the V3 escrow shape). */
    clankerToken: Address;
    /** Signed launch-token amount. */
    clankerAmount: string;
    /** Signature deadline (unix seconds). */
    deadline: string;
    /** Per-claim nonce (bytes32 hex). */
    nonce: `0x${string}`;
    /** EIP-712 signature. */
    sig: `0x${string}`;
    /** Earliest unix-seconds timestamp the claim can be finalized. */
    executeAfter: number;
    /** Twitter handle (without `@`) the OAuth verified. */
    handle: string;
    /** When this entry was written (unix seconds). Used for stale-entry cleanup. */
    savedAt: number;
}

/** localStorage key for a given account's queue. One pending per slot, keyed by `${token}:${slotIndex}`. */
function keyFor(account: Address): string {
    return STORAGE_KEY_PREFIX + account.toLowerCase();
}

function loadAll(account: Address): Record<string, PendingTwitterClaim> {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.localStorage.getItem(keyFor(account));
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        // FSEC-006: validate each entry against the expected shape; drop
        // anything that doesn't pass. Defends against a stray XSS having
        // written a hostile entry that the claim page would otherwise
        // happily route to.
        const out: Record<string, PendingTwitterClaim> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (isValidPendingClaim(v)) out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

function saveAll(account: Address, all: Record<string, PendingTwitterClaim>) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(keyFor(account), JSON.stringify(all));
        // Broadcast same-tab listeners so a banner mounted elsewhere can react
        // immediately to a save/remove. The native "storage" event only fires
        // for OTHER tabs.
        window.dispatchEvent(new CustomEvent(PENDING_CLAIMS_CHANGE_EVENT));
    } catch {
        /* quota exceeded, ignore */
    }
}

export const PENDING_CLAIMS_CHANGE_EVENT = "arcade-pending-claims-change";

function entryKey(token: Address, slotIndex: string | bigint): string {
    return `${token.toLowerCase()}:${slotIndex.toString()}`;
}

/** Save a pending claim after a successful authorize. */
export function savePendingClaim(claim: PendingTwitterClaim) {
    const all = loadAll(claim.account);
    all[entryKey(claim.token, claim.slotIndex)] = claim;
    saveAll(claim.account, all);
}

/** Remove a pending claim after it's been finalized (or vetoed externally). */
export function removePendingClaim(account: Address, token: Address, slotIndex: string | bigint) {
    const all = loadAll(account);
    delete all[entryKey(token, slotIndex)];
    saveAll(account, all);
}

/** Read every pending claim for the wallet. Returns most-recent-first. */
export function listPendingClaims(account: Address | undefined): PendingTwitterClaim[] {
    if (!account) return [];
    return Object.values(loadAll(account)).sort((a, b) => b.savedAt - a.savedAt);
}

/** Read the pending claim for a specific (token, slotIndex), if any. */
export function readPendingClaim(
    account: Address | undefined,
    token: Address | undefined,
    slotIndex: string | bigint | undefined,
): PendingTwitterClaim | undefined {
    if (!account || !token || slotIndex === undefined) return undefined;
    return loadAll(account)[entryKey(token, slotIndex)];
}

/** Builds a `/claim?...` URL from a stored entry, so a banner click resumes the flow. */
export function resumeClaimUrl(claim: PendingTwitterClaim): string {
    const params = new URLSearchParams({
        token: claim.token,
        positionId: claim.positionId,
        slotIndex: claim.slotIndex,
        recipient: claim.recipient,
        pairedToken: claim.pairedToken,
        pairedAmount: claim.pairedAmount,
        clankerToken: claim.clankerToken,
        clankerAmount: claim.clankerAmount,
        deadline: claim.deadline,
        nonce: claim.nonce,
        sig: claim.sig,
        handle: claim.handle,
    });
    return `/claim?${params.toString()}`;
}
