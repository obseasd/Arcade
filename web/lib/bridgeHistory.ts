/**
 * Persists a rolling list of completed CCTP bridges in localStorage so the
 * user can see what they've sent recently. Separate from `pendingBridge`
 * which tracks a single in-flight burn → attest → mint flow.
 */

const KEY = "arcade_bridge_history_v1";
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
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadBridgeHistory(): HistoryEntry[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as HistoryEntry[];
  } catch {
    return [];
  }
}

function save(entries: HistoryEntry[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* quota / privacy - ignore */
  }
}

/** Record a new bridge (call right after the burn confirms). */
export function recordBridge(entry: Omit<HistoryEntry, "id">): string {
  const id = `${entry.burnTxHash}-${entry.burnedAt}`;
  const existing = loadBridgeHistory();
  const next = [{ id, ...entry }, ...existing.filter((e) => e.id !== id)];
  save(next);
  return id;
}

/** Patch a bridge entry (eg when the mint confirms). */
export function updateBridge(id: string, patch: Partial<HistoryEntry>): void {
  const existing = loadBridgeHistory();
  const next = existing.map((e) => (e.id === id ? { ...e, ...patch } : e));
  save(next);
}

/** Patch by burnTxHash. Used when the user refreshed the page between burn
 *  and mint - the in-memory `historyId` is gone but burnTxHash is recoverable
 *  from the persisted pendingBridge entry, so we can still flip the entry to
 *  "minted" without leaking a permanent "pending" row. */
export function updateBridgeByBurnTx(
  burnTxHash: `0x${string}`,
  patch: Partial<HistoryEntry>,
): void {
  const existing = loadBridgeHistory();
  const next = existing.map((e) =>
    e.burnTxHash.toLowerCase() === burnTxHash.toLowerCase() ? { ...e, ...patch } : e,
  );
  save(next);
}

/** Remove a single entry. Used by the per-row dismiss action when a user
 *  has already minted but the history entry was created before the
 *  updateBridgeByBurnTx fix shipped (so it's stuck as "pending"). */
export function removeBridge(id: string): void {
  const existing = loadBridgeHistory();
  save(existing.filter((e) => e.id !== id));
}

export function clearBridgeHistory(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
