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
 *
 * Audit BRIDGE-INJ-PENDING-MINT-GRIEF + BRIDGE-NO-ACCOUNT-BINDING-LOCALSTORAGE:
 * the entry is now scoped to the wallet that initiated the burn. Without this
 * scoping, an attacker with same-origin XSS (or a shared computer) could
 * inject a faux entry whose `recipient` is the attacker's wallet, then the
 * connected victim's wallet would pay the gas to mint USDC to the attacker.
 * loadPendingBridge requires a `forAccount` filter; the resume flow only
 * proceeds when the connected wallet matches.
 */

const BASE_KEY = "arcade_pending_bridge_v1";

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
  /** Wallet that initiated the burn. Used to scope the persisted entry so
   *  a different wallet on the same browser cannot resume someone else's
   *  burn and pay gas to mint USDC into a foreign recipient. */
  account: string;
  createdAt: number;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** Key namespaced by lowercased wallet address. */
function keyFor(account: string): string {
  return `${BASE_KEY}:${account.toLowerCase()}`;
}

/** Read the pending entry that belongs to `forAccount`. Returns null if no
 *  entry exists for that wallet, or if the stored entry's `account` field
 *  doesn't match (defense against the legacy single-key entry being read
 *  cross-wallet). */
export function loadPendingBridge(forAccount: string | undefined): PendingBridge | null {
  if (!isBrowser() || !forAccount) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(forAccount));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingBridge;
    if (!parsed?.burnTxHash || typeof parsed.srcDomain !== "number") return null;
    if (typeof parsed.account !== "string") return null;
    if (parsed.account.toLowerCase() !== forAccount.toLowerCase()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePendingBridge(p: PendingBridge): void {
  if (!isBrowser() || !p.account) return;
  try {
    window.localStorage.setItem(keyFor(p.account), JSON.stringify(p));
  } catch {
    /* quota or privacy mode - silently ignore */
  }
}

export function clearPendingBridge(forAccount: string | undefined): void {
  if (!isBrowser() || !forAccount) return;
  try {
    window.localStorage.removeItem(keyFor(forAccount));
  } catch {
    /* ignore */
  }
  // Best-effort cleanup of the legacy unkeyed entry from before scoping.
  try {
    window.localStorage.removeItem(BASE_KEY);
  } catch {
    /* ignore */
  }
}
