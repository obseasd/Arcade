"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Address } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/constants";
import { BUY_EVT, SELL_EVT, V3_SWAP_EVT } from "@/lib/eventSignatures";
import { CHUNK_SMALL } from "@/lib/eventScan";
import { useWatchEvent } from "@/lib/hooks/useWatchEvent";

export interface Trade {
  txHash: `0x${string}`;
  blockNumber: bigint;
  /** Seconds-ago estimate (Arc ~1s blocks). Computed at render time from latestBlock. */
  blocksAgo: number;
  type: "buy" | "sell";
  /** End-user wallet (buyer / seller for curve, recipient for V3 Swap). */
  wallet: Address;
  /** USDC amount in raw 6-dec units. */
  usdcRaw: bigint;
  /** Token amount in raw 18-dec units. */
  tokenRaw: bigint;
}

const CHUNK = CHUNK_SMALL;
/** Single-phase scan window (~14h on Arc 1s blocks). Replaces the prior
 *  fast+full two-phase pattern that fragmented React Query semantics. */
const SCAN_LOOKBACK = 50_000n;
const MAX_TRADES = 100;

const SCAN_STALE_MS = 30_000;

interface ScanResult {
  trades: Trade[];
  latestBlock: bigint;
}

/**
 * Recent trades on a launchpad token, with live updates via WebSocket.
 *
 * Modes:
 * - PUMP / Arcade (mode 0 or 1): Buy/Sell events from the launchpad contract,
 *   filtered by indexed token.
 * - Clanker V3 (mode 2, USDC-paired): Swap events from the V3 pool. `recipient`
 *   is the end user; sign of `amount0`/`amount1` discriminates buy vs sell.
 *   WETH-paired pools are not yet supported here (returns no trades).
 *
 * Cap at `MAX_TRADES = 100` to keep the panel light. New live trades push to
 * the top and the oldest fall off. React Query backs the historical scan;
 * live WS pushes mutate the cached array via `queryClient.setQueryData`
 * (audit ARCH-007).
 */
export function useTokenTrades(args: {
  token: Address | undefined;
  mode: number | undefined;
  pool?: Address;
}): {
  trades: Trade[];
  isLoading: boolean;
  latestBlock: bigint;
} {
  const { token, mode, pool } = args;
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const isV3 = mode === 2;

  const queryKey = useMemo(
    () => [
      "arcade",
      "token-trades",
      token?.toLowerCase() ?? null,
      mode ?? null,
      pool?.toLowerCase() ?? null,
    ],
    [token, mode, pool],
  );

  const { data, isLoading, isFetching } = useQuery<ScanResult>({
    queryKey,
    enabled:
      !!publicClient && !!token && mode !== undefined && !(isV3 && !pool),
    staleTime: SCAN_STALE_MS,
    gcTime: SCAN_STALE_MS * 5,
    queryFn: async () => {
      if (!publicClient || !token || mode === undefined) {
        return { trades: [], latestBlock: 0n };
      }
      if (isV3 && !pool) return { trades: [], latestBlock: 0n };
      const latest = await publicClient.getBlockNumber();

      // Detect USDC side for V3 pools.
      let usdcIsToken0 = true;
      if (isV3 && pool) {
        try {
          const t0 = await publicClient.readContract({
            address: pool,
            abi: [
              {
                type: "function",
                name: "token0",
                stateMutability: "view",
                inputs: [],
                outputs: [{ type: "address" }],
              },
            ] as const,
            functionName: "token0",
          });
          usdcIsToken0 =
            (t0 as Address).toLowerCase() === ADDRESSES.usdc.toLowerCase();
        } catch {
          /* fall through with default */
        }
      }

      const collected: Trade[] = [];
      const target = latest > SCAN_LOOKBACK ? latest - SCAN_LOOKBACK : 0n;

      let end = latest;
      let errors = 0;
      while (end > target && collected.length < MAX_TRADES) {
        const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
        const from = start > target ? start : target;
        try {
          if (isV3 && pool) {
            const logs = await publicClient.getLogs({
              address: pool,
              event: V3_SWAP_EVT,
              fromBlock: from,
              toBlock: end,
            });
            for (const log of logs)
              collected.push(swapLogToTrade(log, latest, usdcIsToken0));
          } else {
            const [buys, sells] = await Promise.all([
              publicClient.getLogs({
                address: ADDRESSES.launchpad,
                event: BUY_EVT,
                args: { token },
                fromBlock: from,
                toBlock: end,
              }),
              publicClient.getLogs({
                address: ADDRESSES.launchpad,
                event: SELL_EVT,
                args: { token },
                fromBlock: from,
                toBlock: end,
              }),
            ]);
            for (const log of buys) collected.push(buyLogToTrade(log, latest));
            for (const log of sells) collected.push(sellLogToTrade(log, latest));
          }
        } catch {
          errors += 1;
          if (errors > 3) break;
        }
        if (from === 0n) break;
        end = from - 1n;
      }

      const sorted = collected
        .toSorted((a, b) => Number(b.blockNumber - a.blockNumber))
        .slice(0, MAX_TRADES);
      return { trades: sorted, latestBlock: latest };
    },
  });

  const trades = data?.trades ?? [];
  const latestBlock = data?.latestBlock ?? 0n;

  // Live subscriptions: mutate the cached array via setQueryData. The query
  // key is the dependency; merge keeps the top MAX_TRADES with dedup by tx.
  const mergeIntoCache = useCallback(
    (logs: readonly unknown[], mapper: (log: unknown) => Trade) => {
      queryClient.setQueryData<ScanResult | undefined>(queryKey, (prev) => {
        const base = prev ?? { trades: [] as Trade[], latestBlock };
        const merged = mergeLogs(base.trades, logs, mapper);
        if (merged === base.trades) return prev;
        return { ...base, trades: merged };
      });
    },
    [queryClient, queryKey, latestBlock],
  );

  const onBuy = useCallback(
    (logs: readonly unknown[]) => {
      mergeIntoCache(logs, (log) =>
        buyLogToTrade(log as Parameters<typeof buyLogToTrade>[0], latestBlock),
      );
    },
    [mergeIntoCache, latestBlock],
  );
  const onSell = useCallback(
    (logs: readonly unknown[]) => {
      mergeIntoCache(logs, (log) =>
        sellLogToTrade(log as Parameters<typeof sellLogToTrade>[0], latestBlock),
      );
    },
    [mergeIntoCache, latestBlock],
  );
  const onSwap = useCallback(
    (logs: readonly unknown[]) => {
      mergeIntoCache(logs, (log) =>
        swapLogToTrade(
          log as Parameters<typeof swapLogToTrade>[0],
          latestBlock,
          true,
        ),
      );
    },
    [mergeIntoCache, latestBlock],
  );

  useWatchEvent({
    address: !isV3 ? ADDRESSES.launchpad : undefined,
    event: BUY_EVT,
    args: token ? { token } : undefined,
    enabled: !isV3 && !!token,
    onLogs: onBuy,
  });
  useWatchEvent({
    address: !isV3 ? ADDRESSES.launchpad : undefined,
    event: SELL_EVT,
    args: token ? { token } : undefined,
    enabled: !isV3 && !!token,
    onLogs: onSell,
  });
  useWatchEvent({
    address: isV3 ? pool : undefined,
    event: V3_SWAP_EVT,
    enabled: isV3 && !!pool,
    onLogs: onSwap,
  });

  return {
    trades,
    isLoading:
      !!token && mode !== undefined && (isLoading || isFetching),
    latestBlock,
  };
}

/* ------------------------------- Log mappers ------------------------------ */

function buyLogToTrade(log: any, latest: bigint): Trade {
  return {
    txHash: log.transactionHash as `0x${string}`,
    blockNumber: log.blockNumber as bigint,
    blocksAgo: Number(latest - (log.blockNumber as bigint)),
    type: "buy",
    wallet: log.args.buyer as Address,
    usdcRaw: log.args.usdcIn as bigint,
    tokenRaw: log.args.tokensOut as bigint,
  };
}

function sellLogToTrade(log: any, latest: bigint): Trade {
  return {
    txHash: log.transactionHash as `0x${string}`,
    blockNumber: log.blockNumber as bigint,
    blocksAgo: Number(latest - (log.blockNumber as bigint)),
    type: "sell",
    wallet: log.args.seller as Address,
    usdcRaw: log.args.usdcOut as bigint,
    tokenRaw: log.args.tokensIn as bigint,
  };
}

function swapLogToTrade(log: any, latest: bigint, usdcIsToken0: boolean): Trade {
  const a0 = log.args.amount0 as bigint;
  const a1 = log.args.amount1 as bigint;
  const usdcRaw = usdcIsToken0 ? a0 : a1;
  const tokenRaw = usdcIsToken0 ? a1 : a0;
  // In V3 Swap, amount0/amount1 are signed deltas vs the POOL. Negative means
  // the asset left the pool (user received it). Positive means it entered.
  // Buy = user gave USDC (positive into pool), received token (negative out).
  const isBuy = usdcRaw > 0n;
  return {
    txHash: log.transactionHash as `0x${string}`,
    blockNumber: log.blockNumber as bigint,
    blocksAgo: Number(latest - (log.blockNumber as bigint)),
    type: isBuy ? "buy" : "sell",
    wallet: (log.args.recipient as Address) ?? (log.args.sender as Address),
    usdcRaw: usdcRaw < 0n ? -usdcRaw : usdcRaw,
    tokenRaw: tokenRaw < 0n ? -tokenRaw : tokenRaw,
  };
}

/** Insert new logs at the front of the list, dedupe by txHash, cap at MAX_TRADES.
 *  Returns the same reference if nothing changed so setQueryData can short-circuit. */
function mergeLogs(
  prev: Trade[],
  logs: readonly unknown[],
  mapper: (log: unknown) => Trade,
): Trade[] {
  const seen = new Set(prev.map((t) => t.txHash));
  const fresh: Trade[] = [];
  for (const log of logs) {
    const t = mapper(log);
    if (!seen.has(t.txHash)) {
      fresh.push(t);
      seen.add(t.txHash);
    }
  }
  if (fresh.length === 0) return prev;
  return [...fresh, ...prev].slice(0, MAX_TRADES);
}
