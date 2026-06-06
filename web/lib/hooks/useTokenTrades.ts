"use client";

import { useCallback, useEffect, useState } from "react";
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

// Two-phase adaptive scan. Phase 1 covers the recent window for the immediate
// render; phase 2 silently extends history in the background so older trades
// don't get permanently lost.
const CHUNK = CHUNK_SMALL;
const FAST_LOOKBACK = 5_000n; // ~1.4h on Arc (1s blocks) - renders in ~1s
const FULL_LOOKBACK = 50_000n; // ~14h - completes silently after the initial paint
const MAX_TRADES = 100;

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
 * the top and the oldest fall off.
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
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [latestBlock, setLatestBlock] = useState<bigint>(0n);

  const isV3 = mode === 2;

  // -------- Initial historical load (adaptive: fast then extended) ---------
  useEffect(() => {
    if (!publicClient || !token || mode === undefined) {
      setTrades([]);
      return;
    }
    if (isV3 && !pool) {
      setTrades([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        if (!cancelled) setLatestBlock(latest);

        // Detect USDC side for V3 pools (constant for the rest of the scan).
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
            usdcIsToken0 = (t0 as Address).toLowerCase() === ADDRESSES.usdc.toLowerCase();
          } catch {
            /* fall through with default */
          }
        }

        const collected: Trade[] = [];

        /** Run a windowed scan and accumulate Trades into `collected`. Returns
         *  the block we stopped at so the next phase can continue from there. */
        const scanWindow = async (startEnd: bigint, target: bigint): Promise<bigint> => {
          let end = startEnd;
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
                for (const log of logs) collected.push(swapLogToTrade(log, latest, usdcIsToken0));
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
            if (from === 0n) return 0n;
            end = from - 1n;
          }
          return end;
        };

        const fastTarget = latest > FAST_LOOKBACK ? latest - FAST_LOOKBACK : 0n;
        const fullTarget = latest > FULL_LOOKBACK ? latest - FULL_LOOKBACK : 0n;

        // Phase 1: fast window, immediate render.
        let stoppedAt = await scanWindow(latest, fastTarget);
        const snapshot = (): Trade[] => {
          const sorted = [...collected].sort((a, b) => Number(b.blockNumber - a.blockNumber));
          return sorted.slice(0, MAX_TRADES);
        };
        if (!cancelled) {
          setTrades(snapshot());
          setIsLoading(false);
        }

        // Phase 2: extend until FULL_LOOKBACK in the background. Skip if we
        // already hit the MAX_TRADES cap or walked past the full target.
        if (!cancelled && collected.length < MAX_TRADES && stoppedAt > fullTarget) {
          stoppedAt = await scanWindow(stoppedAt, fullTarget);
          if (!cancelled) setTrades(snapshot());
        }
      } catch {
        if (!cancelled) {
          setTrades([]);
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token, mode, pool, isV3]);

  // -------- Live subscriptions ----------------------------------------------
  const onBuy = useCallback((logs: readonly unknown[]) => {
    setTrades((prev) => mergeLogs(prev, logs, (log) => buyLogToTrade(log as Parameters<typeof buyLogToTrade>[0], latestBlock)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestBlock]);
  const onSell = useCallback((logs: readonly unknown[]) => {
    setTrades((prev) => mergeLogs(prev, logs, (log) => sellLogToTrade(log as Parameters<typeof sellLogToTrade>[0], latestBlock)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestBlock]);
  const onSwap = useCallback((logs: readonly unknown[]) => {
    setTrades((prev) => mergeLogs(prev, logs, (log) => swapLogToTrade(log as Parameters<typeof swapLogToTrade>[0], latestBlock, true)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestBlock]);

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

  return { trades, isLoading, latestBlock };
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

/** Insert new logs at the front of the list, dedupe by txHash, cap at MAX_TRADES. */
function mergeLogs<T extends { txHash: string }>(
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
