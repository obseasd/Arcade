/**
 * Generic in-app activity log persisted to localStorage.
 *
 * The HeaderWalletWidget feed merges this with the bridge history and the
 * pending Twitter claims so the user sees the full recent-history list
 * without us depending on an indexer. Every user-initiated tx writes one
 * row here on success (the panels that submit txs call `addActivity` in
 * their success branch, alongside their toast).
 *
 * The Goldsky subgraph (now live) is the GraphQL source; this module stays for
 * offline / pre-hydration state, but the widget hydrates from GraphQL as the source
 * of truth and the localStorage path becomes a fallback.
 */

import type { Address } from "viem";

// Audit F-7: scope per-account so wallet A's history can't be read out
// of the same browser by wallet B (the sibling persistence modules —
// pendingBridge, pendingClaims, bridgeHistory — already key by account).
// The pre-fix single-key bucket leaked metadata (counterparty addresses,
// amounts, timestamps) cross-account on shared devices.
const STORAGE_KEY_BASE = "arcade:activity-feed:v1";
// Legacy single-bucket key kept ONLY for a one-time migration read so
// existing users do not lose their history on the next deploy. Reads
// fall through to it after the per-account key is empty; writes always
// go to the per-account key.
const LEGACY_STORAGE_KEY = "arcade:activity-feed:v1";
const MAX_ENTRIES = 50;

function keyFor(account: string): string {
    return `${STORAGE_KEY_BASE}:${account.toLowerCase()}`;
}

export const ACTIVITY_FEED_CHANGE_EVENT = "arcade-activity-feed-change";

/**
 * Activity categories the wallet feed knows how to render. Pick the icon
 * via `iconForActivity` below; the row label is rendered verbatim from
 * `label` so the call site controls phrasing (eg "$PUMP launched" or
 * "Bought CLANK for 5 USDC").
 */
export type ActivityType =
    | "launch"
    | "buy"
    | "sell"
    | "swap"
    | "multiswap"
    | "claim-fees"
    | "add-liquidity"
    | "remove-liquidity"
    | "send";

export interface ActivityEntry {
    id: string;
    type: ActivityType;
    timestamp: number;
    /** Lowercased wallet address. Used to scope the feed per-account. */
    account: string;
    /** Optional related token address (the launched token, the bought token, etc). */
    token?: Address;
    /** Top-line label, eg "Token launched" or "Bought $PUMP". */
    label: string;
    /** Second-line value, eg "$PUMP" or "5.00 USDC". */
    value: string;
    /** Tx hash for the explorer link in "Voir toute l'activité". */
    txHash?: string;
}

interface OmitId {
    type: ActivityType;
    timestamp?: number;
    account: Address | string;
    token?: Address;
    label: string;
    value: string;
    txHash?: string;
}

// Audit 2026-06-11 UX C-3: per-entry schema validation matching the
// pendingClaims hardening pattern (FSEC-006). A corrupted row — written
// by an old schema, XSS, partial quota-exceeded write, manual user
// fiddling, or a malformed broadcast — used to crash /my-tokens when
// `capitalize(a.type)` hit a null or undefined `type`. Now every entry
// loaded from disk is validated and dropped silently if it doesn't match
// the expected shape. Keeps the feed self-healing across schema bumps.
const ALLOWED_TYPES: ReadonlySet<ActivityType> = new Set([
    "launch",
    "buy",
    "sell",
    "swap",
    "multiswap",
    "claim-fees",
    "add-liquidity",
    "send",
]);

function isValidEntry(v: unknown): v is ActivityEntry {
    if (!v || typeof v !== "object") return false;
    const e = v as Record<string, unknown>;
    return (
        typeof e.id === "string" &&
        typeof e.type === "string" &&
        ALLOWED_TYPES.has(e.type as ActivityType) &&
        typeof e.timestamp === "number" &&
        Number.isFinite(e.timestamp) &&
        typeof e.account === "string" &&
        typeof e.label === "string" &&
        typeof e.value === "string" &&
        (e.token === undefined || typeof e.token === "string") &&
        (e.txHash === undefined || typeof e.txHash === "string")
    );
}

function loadFor(account: string): ActivityEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(keyFor(account));
        if (raw) {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter(isValidEntry) : [];
        }
        // One-time legacy migration: if a pre-F-7 shared bucket exists,
        // read it, filter to this account, and return without writing
        // back to the legacy key. Next saveFor() pushes to the per-
        // account key, and once every account has been touched the
        // legacy key becomes dead state (we keep it around for a release
        // window then clean up in a follow-up).
        const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (!legacyRaw) return [];
        const all = JSON.parse(legacyRaw);
        if (!Array.isArray(all)) return [];
        const acc = account.toLowerCase();
        return all.filter((e) => e?.account === acc).filter(isValidEntry);
    } catch {
        return [];
    }
}

function saveFor(account: string, list: ActivityEntry[]) {
    if (typeof window === "undefined") return;
    try {
        const trimmed = list.slice(0, MAX_ENTRIES);
        window.localStorage.setItem(keyFor(account), JSON.stringify(trimmed));
        window.dispatchEvent(new CustomEvent(ACTIVITY_FEED_CHANGE_EVENT));
    } catch {
        /* quota exceeded, ignore */
    }
}

/**
 * Append a new activity row. Generates the id + falls back to Date.now()
 * for the timestamp so call sites only need to set the meaningful fields.
 */
export function addActivity(entry: OmitId): void {
    const account = entry.account.toLowerCase();
    const all = loadFor(account);
    const next: ActivityEntry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        type: entry.type,
        timestamp: entry.timestamp ?? Date.now(),
        account,
        token: entry.token,
        label: entry.label,
        value: entry.value,
        txHash: entry.txHash,
    };
    saveFor(account, [next, ...all]);
}

/** Read recent activity for a given account (lowercase-compared). */
export function loadActivity(account: Address | undefined): ActivityEntry[] {
    if (!account) return [];
    return loadFor(account.toLowerCase());
}

/**
 * Map an activity type to the public-folder icon path. Keep this in sync
 * with the PNGs in `web/public/`. Generic "contract" covers launches,
 * fee claims, and any other contract-interaction tx.
 */
export function iconForActivity(type: ActivityType): string {
    switch (type) {
        case "launch":
        case "claim-fees":
        case "add-liquidity":
        case "remove-liquidity":
            return "/contract.png";
        case "swap":
        case "multiswap":
        case "buy":
        case "sell":
            return "/swap.png";
        case "send":
            return "/swap.png";
        default:
            return "/contract.png";
    }
}
