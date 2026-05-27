/**
 * Persists the CCTP burn -> attest -> mint flow across page refreshes.
 *
 * After the burn confirms, the destination mint can happen at any time -
 * Circle keeps the message indefinitely until someone calls receiveMessage.
 * If the user refreshes the page (or the tab crashes) before claiming, the
 * in-memory step machine is wiped and they'd lose the "Mint" button.
 *
 * We save the minimal data needed to resume: the burn tx hash, source CCTP
 * domain, destination chain id, and a few labels for UX. On mount, BridgeCard
 * reads this back and renders a banner that resumes attestation polling
 * exactly where the user left off.
 */

const KEY = "arcade_pending_bridge_v1";

export interface PendingBridge {
  burnTxHash: `0x${string}`;
  srcDomain: number;
  srcChainId: number;
  dstId: number;
  /** USDC amount in raw 6dp units, serialised as a string since bigint
   * isn't JSON-serialisable. */
  amountRaw6: string;
  /** Resolved recipient - override or connected wallet at burn time. */
  recipient: string;
  createdAt: number;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadPendingBridge(): PendingBridge | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingBridge;
    // Soft sanity check - ignore obviously malformed entries.
    if (!parsed?.burnTxHash || typeof parsed.srcDomain !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePendingBridge(p: PendingBridge): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* quota or privacy mode - silently ignore */
  }
}

export function clearPendingBridge(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
