import type { Address } from "viem";

/**
 * Optimistic own-trade store (in-memory, per session). After a user's trade
 * CONFIRMS on-chain, the trade panel stashes a structured row here so the token
 * page shows it INSTANTLY, before the Goldsky subgraph indexes it (which can lag
 * tens of seconds on the trial plan). The token page dedups by txHash, so the
 * moment the subgraph version arrives it replaces the optimistic one; entries are
 * pruned after a short TTL as a backstop.
 *
 * Amounts come from the pre-trade QUOTE (estimatedOut), so they can differ from
 * the exact fill by the realized slippage for the few seconds until the subgraph
 * row (the true fill) supersedes them. This is the only tradeoff and it is
 * cosmetic + transient.
 */
export interface OptimisticTrade {
  /** Lowercased token address the trade belongs to. */
  token: string;
  txHash: `0x${string}`;
  wallet: Address;
  type: "buy" | "sell";
  usdcRaw: bigint;
  tokenRaw: bigint;
  /** Date.now() at confirmation. */
  timeMs: number;
}

const TTL_MS = 3 * 60_000; // the subgraph has surely indexed it within 3 min
const store: OptimisticTrade[] = [];
const listeners = new Set<() => void>();

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].timeMs < cutoff) store.splice(i, 1);
  }
}

/** Record a just-confirmed trade. Idempotent per txHash. */
export function addOptimisticTrade(t: OptimisticTrade): void {
  if (store.some((x) => x.txHash.toLowerCase() === t.txHash.toLowerCase())) return;
  store.push({ ...t, token: t.token.toLowerCase() });
  prune();
  listeners.forEach((l) => l());
}

/** Current optimistic trades for a token (newest not guaranteed; caller sorts). */
export function getOptimisticTrades(token: string): OptimisticTrade[] {
  prune();
  const t = token.toLowerCase();
  return store.filter((x) => x.token === t);
}

/** Subscribe to store changes (for a React effect). Returns an unsubscribe fn. */
export function subscribeOptimisticTrades(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
