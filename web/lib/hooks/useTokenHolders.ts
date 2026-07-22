"use client";

import { useQuery } from "@tanstack/react-query";
import { Address, parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import { CHUNK_MEDIUM } from "@/lib/eventScan";

// Generic ERC20 Transfer; not in eventSignatures since it's wagmi/erc20Abi
// territory and would clutter the launchpad-specific export list.
const TRANSFER_EVT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export interface Holder {
  address: Address;
  balanceRaw: bigint;
  /** balanceRaw / totalSupply * 100, 0..100. */
  pctOfSupply: number;
}

const CHUNK = CHUNK_MEDIUM;
/** Single-phase scan window (~28h at 1s block time on Arc). The previous
 *  fast+full phased pattern fragmented React Query semantics; this single
 *  scan caches for 90s so the second visit is instant anyway. */
const SCAN_LOOKBACK = 100_000n;

const SCAN_STALE_MS = 90_000;

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

/** Holders from the subgraph's TokenBalance entity (indexed from the Transfer
 *  template). Returns null on any miss (unset / pre-redeploy / not-indexed) so
 *  the caller falls back to the client Transfer scan. */
async function holdersFromSubgraph(token: Address, totalSupply: bigint): Promise<Holder[] | null> {
  if (!GOLDSKY_URL) return null;
  try {
    const q = `{ tokenBalances(first: 100, orderBy: balanceRaw, orderDirection: desc, where: { token: "${token.toLowerCase()}", balanceRaw_gt: "0" }) { holder balanceRaw } }`;
    const res = await fetch(GOLDSKY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { tokenBalances?: { holder: string; balanceRaw: string }[] };
      errors?: unknown;
    };
    const rows = json?.data?.tokenBalances;
    if (!Array.isArray(rows)) return null; // field missing pre-redeploy
    const out: Holder[] = [];
    for (const r of rows) {
      const bal = BigInt(r.balanceRaw);
      if (bal < DUST_THRESHOLD_WEI) continue;
      const pct = totalSupply > 0n ? Number((bal * 10_000n) / totalSupply) / 100 : 0;
      out.push({ address: r.holder as Address, balanceRaw: bal, pctOfSupply: pct });
    }
    return out;
  } catch {
    return null;
  }
}

/** Holders with less than one whole token are treated as dust and dropped
 *  from the list. The launchpad's swept-rounding leftover after
 *  `lockSingleSided` lands here (a few wei) and would show as a confusing
 *  "0" row otherwise. */
const DUST_THRESHOLD_WEI = 10n ** 18n;

/**
 * Builds the holder list for an ERC20 token by replaying Transfer events.
 * For each transfer, mutates a balance Map; filters out the zero address and
 * any addresses with a final balance below DUST_THRESHOLD_WEI. Sorts by
 * balance desc.
 *
 * React-Query-backed: dedupes the chunked scan across consumers and caches
 * the result for 90s (audit ARCH-007). Trade-off vs the prior two-phase
 * pattern: first paint now waits for the full window, but cached visits and
 * cross-component dedupe make every subsequent render free.
 */
export function useTokenHolders(
  token: Address | undefined,
  totalSupply: bigint,
): { holders: Holder[]; totalHolders: number; isLoading: boolean } {
  const publicClient = usePublicClient();

  // Exact holder count from the subgraph (Token.holderCount) -- the balances
  // list below is capped at 100 for display, so `holders.length` under-counts
  // the true holder base. Null when the subgraph is unset / pre-redeploy.
  const countQ = useQuery<number | null>({
    queryKey: ["arcade", "holder-count", token?.toLowerCase() ?? null],
    enabled: !!GOLDSKY_URL && !!token,
    // Was 60s stale / 120s poll -> the holder count lagged a full 1-2 min behind
    // a trade. The subgraph count query is a single cheap GraphQL call, so poll it
    // fast (matching the trades feed's responsiveness).
    staleTime: 10_000,
    refetchInterval: 12_000,
    queryFn: async () => {
      if (!GOLDSKY_URL || !token) return null;
      try {
        const res = await fetch(GOLDSKY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: `{ token(id: "${token.toLowerCase()}") { holderCount } }` }),
        });
        if (!res.ok) return null;
        const j = (await res.json()) as { data?: { token?: { holderCount?: number } | null } };
        const c = j?.data?.token?.holderCount;
        return typeof c === "number" ? c : null;
      } catch {
        return null;
      }
    },
  });

  const { data, isLoading, isFetching } = useQuery<Holder[]>({
    // thouders-no-totalSupply-reactivity: totalSupply lives in the
    // RETURNED data (for pct calc), not in the queryKey, so the chunked
    // 100k-block Transfer scan doesn't restart whenever a caller's
    // useReadContract for totalSupply transitions from undefined -> N.
    queryKey: ["arcade", "token-holders", token?.toLowerCase() ?? null],
    enabled: !!publicClient && !!token,
    // Poll the holder list every ~12s (was 90s stale, no interval -> the list
    // lagged over a minute). The normal path is a single cheap subgraph query;
    // the heavy on-chain Transfer scan only runs on a subgraph miss (rare), so
    // the faster cadence does not add RPC load in practice.
    staleTime: 10_000,
    refetchInterval: 12_000,
    gcTime: SCAN_STALE_MS * 5,
    queryFn: async () => {
      if (!publicClient || !token) return [];
      // Prefer the subgraph (indexed balances) over the 100k-block Transfer
      // scan. Falls through when the subgraph is unset / pre-redeploy.
      const indexed = await holdersFromSubgraph(token, totalSupply);
      if (indexed !== null) return indexed;
      const balances = new Map<string, bigint>();
      try {
        const latest = await publicClient.getBlockNumber();
        const target = latest > SCAN_LOOKBACK ? latest - SCAN_LOOKBACK : 0n;

        let end = latest;
        let errors = 0;
        while (end > target) {
          const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
          const from = start > target ? start : target;
          try {
            const logs = await publicClient.getLogs({
              address: token,
              event: TRANSFER_EVT,
              fromBlock: from,
              toBlock: end,
            });
            applyLogs(logs, balances);
          } catch {
            errors += 1;
            if (errors > 3) break;
          }
          if (from === 0n) break;
          end = from - 1n;
        }
      } catch {
        // fall through with whatever partial balances we got
      }
      return mapToHolders(balances, totalSupply);
    },
  });

  const holders = data ?? [];
  // Prefer the exact subgraph count; fall back to the (capped) list length.
  const totalHolders = countQ.data != null ? countQ.data : holders.length;
  return {
    holders,
    totalHolders,
    isLoading: !!token && (isLoading || isFetching),
  };
}

function applyLogs(logs: any[], balances: Map<string, bigint>) {
  for (const log of logs) {
    const fromAddr = (log.args.from as Address)?.toLowerCase() ?? ZERO;
    const toAddr = (log.args.to as Address)?.toLowerCase() ?? ZERO;
    const value = (log.args.value as bigint) ?? 0n;
    if (fromAddr !== ZERO) {
      balances.set(fromAddr, (balances.get(fromAddr) ?? 0n) - value);
    }
    if (toAddr !== ZERO) {
      balances.set(toAddr, (balances.get(toAddr) ?? 0n) + value);
    }
  }
}

function mapToHolders(balances: Map<string, bigint>, totalSupply: bigint): Holder[] {
  const out: Holder[] = [];
  for (const [addr, bal] of balances) {
    if (bal < DUST_THRESHOLD_WEI) continue;
    const pct = totalSupply > 0n ? Number((bal * 10_000n) / totalSupply) / 100 : 0;
    out.push({ address: addr as Address, balanceRaw: bal, pctOfSupply: pct });
  }
  // thouders-bigint-sort-overflow: compare bigints directly. The previous
  // `Number(b - a)` collapsed any pairwise diff above ~2^53 (~9e15) into
  // 0/Infinity, which on launchpad tokens (18 dp, 1B supply -> single
  // balance up to 1e27 wei) silently broke the whale ordering. Return
  // -1 / 0 / 1 so the JS sort sees a stable comparator.
  out.sort((a, b) => {
    if (b.balanceRaw > a.balanceRaw) return 1;
    if (b.balanceRaw < a.balanceRaw) return -1;
    return 0;
  });
  return out;
}
