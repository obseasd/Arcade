"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Address } from "viem";
import { usePublicClient, useReadContract } from "wagmi";
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

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

/**
 * Trade feed from the Goldsky subgraph for ANY venue. The Trade entity id is
 * `${txHash}-${logIndex}` so we recover the real tx hash for the explorer link.
 * volumeUsdc is whole USDC and price is USDC-per-token (subgraph BigDecimals);
 * we scale back to the raw 6-/18-dec units the row renderer expects. `trader`
 * is the subgraph's recorded wallet. `sourceWhere` is the GraphQL fragment that
 * pins the venue (e.g. `source: "v3"` or `source_in: ["v4","v4curve"]`).
 */
async function fetchTradesFromSubgraph(token: Address, sourceWhere: string): Promise<Trade[]> {
  if (!GOLDSKY_URL) return [];
  const q = `{ trades(first: ${MAX_TRADES}, orderBy: blockNumber, orderDirection: desc, where: { token: "${token.toLowerCase()}", ${sourceWhere} }) { id trader price volumeUsdc isBuy blockTime blockNumber } }`;
  try {
    const res = await fetch(GOLDSKY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: {
        trades?: Array<{
          id: string;
          trader: string;
          price: string | number;
          volumeUsdc: string | number;
          isBuy: boolean;
          blockTime: string | number;
          blockNumber: string | number;
        }>;
      };
    };
    const rows = json?.data?.trades ?? [];
    const nowSec = Math.floor(Date.now() / 1000);
    return rows.map((r) => {
      const vol = Number(r.volumeUsdc); // whole USDC
      const price = Number(r.price); // USDC per token
      const usdcRaw = BigInt(Math.max(0, Math.round(vol * 1e6)));
      const tokens = price > 0 ? vol / price : 0;
      // Two-step scale keeps Number precision on large token counts.
      const tokenRaw = BigInt(Math.max(0, Math.floor(tokens * 1e6))) * 10n ** 12n;
      const txHash = ((r.id.split("-")[0] ?? "0x") as `0x${string}`);
      const blockTime = Number(r.blockTime);
      return {
        txHash,
        blockNumber: BigInt(r.blockNumber),
        blocksAgo: Math.max(0, nowSec - (Number.isFinite(blockTime) ? blockTime : nowSec)),
        type: r.isBuy ? "buy" : "sell",
        wallet: r.trader as Address,
        usdcRaw,
        tokenRaw,
      } satisfies Trade;
    });
  } catch {
    return [];
  }
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
  /** Launchpad that actually holds this (curve) token. Defaults to the live
   *  launchpad; pass the resolved per-generation address for older tokens so
   *  the Buy/Sell scan + live watch hit the right contract (pages audit
   *  2026-07-02: prior-generation curve tokens showed "No trades yet"). */
  launchpad?: Address;
  /** "v4" for ArcadeHook tokens: their trades live on the shared V4
   *  PoolManager and are only surfaced via the subgraph, so we read the feed
   *  from Goldsky instead of scanning legacy launchpad / V3 events. */
  source?: string;
}): {
  trades: Trade[];
  isLoading: boolean;
  latestBlock: bigint;
} {
  const { token, mode, pool, source } = args;
  const lp = args.launchpad ?? ADDRESSES.launchpad;
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const isV3 = mode === 2;

  // Read V3 pool token0 outside the queryFn so the WS push path can use the
  // correct USDC orientation. Previously the live push hard-coded
  // usdcIsToken0=true which inverted price+volume on token0!=USDC pools.
  const t0Query = useReadContract({
    address: isV3 && pool ? pool : undefined,
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
    query: { enabled: isV3 && !!pool, staleTime: Infinity },
  });
  const usdcIsToken0V3 = useMemo<boolean | null>(() => {
    if (!isV3 || !t0Query.data) return null;
    return (t0Query.data as string).toLowerCase() === ADDRESSES.usdc.toLowerCase();
  }, [isV3, t0Query.data]);

  const queryKey = useMemo(
    () => [
      "arcade",
      "token-trades",
      token?.toLowerCase() ?? null,
      mode ?? null,
      pool?.toLowerCase() ?? null,
      lp.toLowerCase(),
      source ?? null,
    ],
    [token, mode, pool, lp, source],
  );

  const { data, isLoading, isFetching } = useQuery<ScanResult>({
    queryKey,
    enabled:
      !!publicClient && !!token && mode !== undefined && !(isV3 && !pool),
    staleTime: SCAN_STALE_MS,
    gcTime: SCAN_STALE_MS * 5,
    // V4-hook trades don't emit through the legacy launchpad, so the useWatchEvent
    // live-push below never fires for them. Poll the Goldsky subgraph every 5s so
    // OTHER traders' fills appear near-real-time on the token page (the user's own
    // trade already refetches instantly via the panel's onTradeSuccess).
    refetchInterval: source === "v4" ? 2_000 : undefined,
    queryFn: async () => {
      if (!publicClient || !token || mode === undefined) {
        return { trades: [], latestBlock: 0n };
      }
      const latest = await publicClient.getBlockNumber();

      // Subgraph-first for EVERY venue (retires the per-token getLogs walk).
      // Venue -> Trade.source: v4 hook = v4/v4curve, CLANKER_V3 = v3, curve =
      // curve. If the subgraph returns rows, use them; otherwise fall through
      // to the on-chain scan (v4 has no scan fallback -> empty).
      const sourceWhere =
        source === "v4"
          ? `source_in: ["v4", "v4curve"]`
          : isV3
            ? `source: "v3"`
            : `source: "curve"`;
      const indexed = await fetchTradesFromSubgraph(token, sourceWhere);
      if (indexed.length > 0) return { trades: indexed, latestBlock: latest };
      if (source === "v4") return { trades: [], latestBlock: latest };

      if (isV3 && !pool) return { trades: [], latestBlock: 0n };

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
                address: lp,
                event: BUY_EVT,
                args: { token },
                fromBlock: from,
                toBlock: end,
              }),
              publicClient.getLogs({
                address: lp,
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
      // Merge with any trades the WS push wrote between query-start and now;
      // dedupe by txHash so the live trades aren't dropped on scan completion.
      const prior = queryClient.getQueryData<ScanResult | undefined>(queryKey);
      const priorFresh = (prior?.trades ?? []).filter(
        (p) => !sorted.some((s) => s.txHash === p.txHash),
      );
      const merged = [...priorFresh, ...sorted]
        .sort((a, b) => Number(b.blockNumber - a.blockNumber))
        .slice(0, MAX_TRADES);
      return { trades: merged, latestBlock: latest };
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
      // Skip until the token0 lookup lands; an inverted price/volume pushed
      // to the cache and then cleared on next refetch is worse than a 1-2
      // dropped log at startup.
      if (usdcIsToken0V3 === null) return;
      mergeIntoCache(logs, (log) =>
        swapLogToTrade(
          log as Parameters<typeof swapLogToTrade>[0],
          latestBlock,
          usdcIsToken0V3,
        ),
      );
    },
    [mergeIntoCache, latestBlock, usdcIsToken0V3],
  );

  // Stable args object so useWatchEvent's deps don't churn every render and
  // tear down/re-subscribe the WebSocket each tick.
  const tokenArgs = useMemo(() => (token ? { token } : undefined), [token]);
  useWatchEvent({
    address: !isV3 ? lp : undefined,
    event: BUY_EVT,
    args: tokenArgs,
    enabled: !isV3 && !!token,
    onLogs: onBuy,
  });
  useWatchEvent({
    address: !isV3 ? lp : undefined,
    event: SELL_EVT,
    args: tokenArgs,
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
