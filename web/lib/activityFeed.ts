/**
 * Generic in-app activity log persisted to localStorage.
 *
 * The HeaderWalletWidget feed merges this with the bridge history and the
 * pending Twitter claims so the user sees the full recent-history list
 * without us depending on an indexer. Every user-initiated tx writes one
 * row here on success (the panels that submit txs call `addActivity` in
 * their success branch, alongside their toast).
 *
 * Once the Ponder indexer lands, this module stays for offline / pre-
 * indexer state, but the widget will hydrate from GraphQL as the source
 * of truth and the localStorage path becomes a fallback.
 */

import type { Address } from "viem";

const STORAGE_KEY = "arcade:activity-feed:v1";
const MAX_ENTRIES = 50;

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
    | "claim-fees";

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

function loadAll(): ActivityEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveAll(list: ActivityEntry[]) {
    if (typeof window === "undefined") return;
    try {
        // Cap to MAX_ENTRIES total to keep localStorage from growing
        // unbounded for power users. Oldest entries drop off first.
        const trimmed = list.slice(0, MAX_ENTRIES);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
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
    const all = loadAll();
    const next: ActivityEntry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        type: entry.type,
        timestamp: entry.timestamp ?? Date.now(),
        account: entry.account.toLowerCase(),
        token: entry.token,
        label: entry.label,
        value: entry.value,
        txHash: entry.txHash,
    };
    saveAll([next, ...all]);
}

/** Read recent activity for a given account (lowercase-compared). */
export function loadActivity(account: Address | undefined): ActivityEntry[] {
    if (!account) return [];
    const acc = account.toLowerCase();
    return loadAll().filter((e) => e.account === acc);
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
            return "/contract.png";
        case "swap":
        case "multiswap":
        case "buy":
        case "sell":
            return "/swap.png";
        default:
            return "/contract.png";
    }
}
