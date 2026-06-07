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

  const { data, isLoading, isFetching } = useQuery<Holder[]>({
    // thouders-no-totalSupply-reactivity: totalSupply lives in the
    // RETURNED data (for pct calc), not in the queryKey, so the chunked
    // 100k-block Transfer scan doesn't restart whenever a caller's
    // useReadContract for totalSupply transitions from undefined -> N.
    queryKey: ["arcade", "token-holders", token?.toLowerCase() ?? null],
    enabled: !!publicClient && !!token,
    staleTime: SCAN_STALE_MS,
    gcTime: SCAN_STALE_MS * 5,
    queryFn: async () => {
      if (!publicClient || !token) return [];
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
  return {
    holders,
    totalHolders: holders.length,
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
