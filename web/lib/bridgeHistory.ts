/**
 * Persists a rolling list of completed CCTP bridges in localStorage so the
 * user can see what they've sent recently. Separate from `pendingBridge`
 * which tracks a single in-flight burn → attest → mint flow.
 *
 * Audit BRIDGE-NO-ACCOUNT-BINDING-LOCALSTORAGE: history entries are now
 * namespaced by wallet so connecting a different wallet on the same
 * browser doesn't show the previous wallet's bridges. The persisted entry
 * also stores `account` and load filters on it as a defense-in-depth
 * check against tampered localStorage.
 */

const BASE_KEY = "arcade_bridge_history_v1";
const MAX_ENTRIES = 20;

export interface HistoryEntry {
  id: string;
  srcChainId: number;
  dstChainId: number;
  /** USDC amount in raw 6dp units, serialised as a string (bigint isn't JSON). */
  amountRaw6: string;
  recipient: string;
  burnTxHash: `0x${string}`;
  mintTxHash?: `0x${string}`;
  status: "pending" | "minted" | "failed";
  /** Epoch ms at burn time. */
  burnedAt: number;
  /** Epoch ms at mint time (if minted). */
  mintedAt?: number;
  /**
   * Set to true once Circle's Iris attestation comes back complete - the
   * row is now mintable. UI flips the badge from "Pending" (still waiting
   * on attestation) to "To claim" so the user knows they have an action
   * to take. Stays true through `mintTxHash` confirmation, at which point
   * status flips to "minted" and supersedes the badge anyway.
   */
  attestationReady?: boolean;
  /**
   * Audit 2026-06-11 bug #8: cache the Iris message + signature blobs so
   * whichever poller catches `complete` first (BridgeHistory's 60s sweep
   * or BridgeCard's 6s active poll) can hand the blob to the OTHER one
   * via the localStorage event. Without this the "To claim" badge could
   * fire 60s before BridgeCard's poll catches up, leaving the claim
   * button greyed out while the badge invites the user to claim. Both
   * blobs are 0x-prefixed hex strings stored as-is; the consumer parses
   * them via parseCctpV2Message and re-verifies sourceDomain /
   * destinationDomain / mintRecipient before transitioning to mint.
   */
  attestationMessage?: `0x${string}`;
  attestationSignature?: `0x${string}`;
  /** Wallet that initiated this bridge. Used to scope the list per wallet. */
  account?: string;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function keyFor(account: string): string {
  return `${BASE_KEY}:${account.toLowerCase()}`;
}

/** Load the history for `forAccount`. Returns [] when no account is connected
 *  (the legacy unscoped key is intentionally NOT read so a fresh wallet
 *  doesn't show the previous wallet's bridges). Entries whose persisted
 *  `account` doesn't match are filtered out as a tamper guard. */
export function loadBridgeHistory(forAccount: string | undefined): HistoryEntry[] {
  if (!isBrowser() || !forAccount) return [];
  try {
    const raw = window.localStorage.getItem(keyFor(forAccount));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const lcAccount = forAccount.toLowerCase();
    return (parsed as HistoryEntry[]).filter(
      (e) => typeof e.account === "string" && e.account.toLowerCase() === lcAccount,
    );
  } catch {
    return [];
  }
}

/** Custom event the BridgeHistory component listens to. We fire it on every
 *  `save` so same-tab updates are picked up immediately (the native
 *  "storage" event only fires for OTHER tabs, leaving the active tab stale
 *  until the user refreshes). */
const CHANGE_EVENT = "arcade-bridge-history-changed";

function save(account: string, entries: HistoryEntry[]): void {
  if (!isBrowser() || !account) return;
  try {
    window.localStorage.setItem(
      keyFor(account),
      JSON.stringify(entries.slice(0, MAX_ENTRIES)),
    );
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* quota / privacy. ignore. */
  }
}

export const BRIDGE_HISTORY_CHANGE_EVENT = CHANGE_EVENT;

/** Record a new bridge (call right after the burn confirms). */
export function recordBridge(
  account: string,
  entry: Omit<HistoryEntry, "id" | "account">,
): string {
  const id = `${entry.burnTxHash}-${entry.burnedAt}`;
  const existing = loadBridgeHistory(account);
  const next: HistoryEntry[] = [
    { id, account, ...entry },
    ...existing.filter((e) => e.id !== id),
  ];
  save(account, next);
  return id;
}

/** Patch a bridge entry (eg when the mint confirms). */
export function updateBridge(
  account: string,
  id: string,
  patch: Partial<HistoryEntry>,
): void {
  const existing = loadBridgeHistory(account);
  const next = existing.map((e) => (e.id === id ? { ...e, ...patch } : e));
  save(account, next);
}

/** Patch by burnTxHash. Used when the user refreshed the page between burn
 *  and mint - the in-memory `historyId` is gone but burnTxHash is recoverable
 *  from the persisted pendingBridge entry, so we can still flip the entry to
 *  "minted" without leaking a permanent "pending" row. */
export function updateBridgeByBurnTx(
  account: string,
  burnTxHash: `0x${string}`,
  patch: Partial<HistoryEntry>,
): void {
  const existing = loadBridgeHistory(account);
  const next = existing.map((e) =>
    e.burnTxHash.toLowerCase() === burnTxHash.toLowerCase() ? { ...e, ...patch } : e,
  );
  save(account, next);
}

/** Remove a single entry. Used by the per-row dismiss action when a user
 *  has already minted but the history entry was created before the
 *  updateBridgeByBurnTx fix shipped (so it's stuck as "pending"). */
export function removeBridge(account: string, id: string): void {
  const existing = loadBridgeHistory(account);
  save(account, existing.filter((e) => e.id !== id));
}
