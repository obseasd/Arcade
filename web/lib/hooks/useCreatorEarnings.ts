"use client";

import { useEffect, useMemo, useState } from "react";
import { Address, parseAbiItem } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useV3Tokens } from "./useV3Tokens";

const RECIPIENT_PAID_EVT = parseAbiItem(
  "event RecipientPaid(uint256 indexed positionId, uint256 indexed slotIndex, address indexed token, address recipient, uint256 amount)",
);

const CHUNK = 10_000n;
/** Phase 1 lookback (~14h on Arc 1s blocks). Fast initial render. */
const FAST_LOOKBACK = 50_000n;
/**
 * Phase 2 lookback (~5.8 days on Arc 1s blocks). Today on Arc testnet this
 * covers the entire launchpad history because the latest deploy is only
 * hours old. Once mainnet has months of activity we'll need an indexer
 * (subgraph or ponder.sh) since walking millions of blocks per page load is
 * not viable. Noted in MEMORY as a post-mainnet task.
 */
const FULL_LOOKBACK = 500_000n;
const DAY_SECONDS = 86_400;
/** Max days the sparkline ever displays even if there's older data. */
const MAX_CHART_DAYS = 30;

/** Per-token aggregated earnings. */
export interface TokenEarnings {
  token: Address;
  symbol?: string;
  /** Total claimed in raw units (USDC has 6 dp, others 18). */
  amountRaw: bigint;
  /** USD value at the moment of claim (placeholder: USDC=1, others=0). */
  amountUsd: number;
  decimals: number;
  /** Number of distinct `collectFees` calls that paid this slot. */
  payouts: number;
}

/** Daily bucket for the sparkline. Index 0 = oldest, last = today. */
export interface DailyEarnings {
  /** Epoch seconds at the start of the day. */
  daySeconds: number;
  /** USD claimed that day (USDC only for now). */
  amountUsd: number;
}

export interface CreatorEarningsResult {
  /** Total USD claimed in the visible window (USDC only). */
  claimedUsd: number;
  /** Pending (unclaimed) USD across all positions. */
  pendingUsd: number;
  /** Top tokens by claimed USD. */
  perToken: TokenEarnings[];
  /** One bucket per day in the window. */
  daily: DailyEarnings[];
  /** Whether the phase 2 extended scan has finished. */
  fullyLoaded: boolean;
  isLoading: boolean;
}

interface CreatorPosition {
  token: Address;
  positionId: bigint;
  symbol?: string;
}

/**
 * Aggregates V3 locker LP fee claims paid to the connected wallet over the
 * recent past, plus pending (unclaimed) preview amounts.
 *
 * Strategy:
 *   1. Walk every Clanker V3 launch to find positions where the wallet is a
 *      recipient (or its slot's admin). Re-uses the same logic as
 *      CreatorFeesPanel - the slots are the same; this hook just adds the
 *      historical aggregation on top.
 *   2. For each such position, scan `RecipientPaid` events (indexed by
 *      positionId) over a fast window first, then extend in the background.
 *      Filter by `recipient == account` (non-indexed, done client-side).
 *   3. For pending: read previewFees(positionId) and apply the recipient's
 *      bps share. Same pattern as CreatorFeesPanel.
 *
 * Trade-off: 7 days is the full scan window. Older claims aren't visible
 * yet. Indexer (post-mainnet) makes this trivial; for now 7 days covers the
 * relevant window for any active creator.
 */
export function useCreatorEarnings(): CreatorEarningsResult {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { tokens: v3Tokens, isLoading: tokensLoading } = useV3Tokens();

  // 1) Get position ids for every V3 token.
  const idCalls = useReadContracts({
    contracts: v3Tokens.map((t) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "positionIdByToken" as const,
      args: [t.address] as const,
    })),
    query: { enabled: v3Tokens.length > 0 },
  });
  const positionIds = (idCalls.data ?? []).map((c) =>
    c.status === "success" ? (c.result as bigint) : 0n,
  );

  // 2) Recipients per position - filter to ones where the wallet is involved.
  const recCalls = useReadContracts({
    contracts: positionIds.map((id) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "getRecipients" as const,
      args: [id] as const,
    })),
    query: { enabled: positionIds.some((id) => id > 0n) },
  });

  const mine: CreatorPosition[] = useMemo(() => {
    if (!account || !recCalls.data) return [];
    const acc = account.toLowerCase();
    const out: CreatorPosition[] = [];
    for (let i = 0; i < v3Tokens.length; i++) {
      const r = recCalls.data[i];
      if (r?.status !== "success") continue;
      const recips = r.result as readonly { recipient: Address; admin: Address }[];
      const isMine = recips?.some(
        (x) => x.recipient.toLowerCase() === acc || x.admin.toLowerCase() === acc,
      );
      if (isMine) {
        out.push({ token: v3Tokens[i].address, positionId: positionIds[i], symbol: v3Tokens[i].symbol });
      }
    }
    return out;
  }, [account, recCalls.data, v3Tokens, positionIds]);

  // 3) Pending (unclaimed) preview across all positions.
  const previewCalls = useReadContracts({
    contracts: mine.map((p) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "previewFees" as const,
      args: [p.positionId] as const,
    })),
    query: { enabled: mine.length > 0, refetchInterval: 30_000 },
  });

  const pendingUsd = useMemo(() => {
    if (!previewCalls.data) return 0;
    let sum = 0n;
    for (const r of previewCalls.data) {
      if (r?.status !== "success") continue;
      const [paired] = r.result as readonly [bigint, bigint];
      sum += paired;
    }
    return Number(sum) / 10 ** USDC_DECIMALS;
  }, [previewCalls.data]);

  // 4) Historical claims: scan RecipientPaid for each position.
  const [byToken, setByToken] = useState<Map<string, TokenEarnings>>(new Map());
  const [byDay, setByDay] = useState<Map<number, number>>(new Map());
  const [fullyLoaded, setFullyLoaded] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!publicClient || !account || mine.length === 0) {
      setByToken(new Map());
      setByDay(new Map());
      setFullyLoaded(false);
      return;
    }
    let cancelled = false;
    setScanning(true);
    setFullyLoaded(false);

    (async () => {
      try {
        const latest = await publicClient.getBlock();
        const latestN = latest.number as bigint;
        const latestTs = Number(latest.timestamp);
        const acc = account.toLowerCase();
        const tokensMap = new Map<string, TokenEarnings>();
        const daysMap = new Map<number, number>();

        /** Scan a window per position, in parallel across all positions. */
        const scanWindow = async (end: bigint, target: bigint) => {
          const perPositionWalks = mine.map(async (p) => {
            let cursor = end;
            let errors = 0;
            while (cursor > target) {
              const start = cursor > CHUNK - 1n ? cursor - (CHUNK - 1n) : 0n;
              const from = start > target ? start : target;
              try {
                const logs = await publicClient.getLogs({
                  address: ADDRESSES.v3Locker,
                  event: RECIPIENT_PAID_EVT,
                  args: { positionId: p.positionId },
                  fromBlock: from,
                  toBlock: cursor,
                });
                for (const log of logs) {
                  const recipient = (log.args.recipient as Address)?.toLowerCase();
                  if (recipient !== acc) continue;
                  const tokenAddr = (log.args.token as Address).toLowerCase();
                  const amount = log.args.amount as bigint;
                  const isUsdc = tokenAddr === ADDRESSES.usdc.toLowerCase();
                  const decimals = isUsdc ? USDC_DECIMALS : 18;
                  const ts = latestTs - Number(latestN - (log.blockNumber as bigint));

                  const prev = tokensMap.get(tokenAddr);
                  const amountUsd = isUsdc ? Number(amount) / 10 ** USDC_DECIMALS : 0;
                  if (prev) {
                    prev.amountRaw += amount;
                    prev.amountUsd += amountUsd;
                    prev.payouts += 1;
                  } else {
                    tokensMap.set(tokenAddr, {
                      token: tokenAddr as Address,
                      symbol: isUsdc ? "USDC" : p.symbol,
                      amountRaw: amount,
                      amountUsd,
                      decimals,
                      payouts: 1,
                    });
                  }
                  // Day bucket (UTC midnight as anchor; USDC-only USD tally for the chart).
                  const day = Math.floor(ts / DAY_SECONDS) * DAY_SECONDS;
                  daysMap.set(day, (daysMap.get(day) ?? 0) + amountUsd);
                }
              } catch {
                errors += 1;
                if (errors > 3) break;
              }
              if (from === 0n) return;
              cursor = from - 1n;
            }
          });
          await Promise.all(perPositionWalks);
        };

        const fastTarget = latestN > FAST_LOOKBACK ? latestN - FAST_LOOKBACK : 0n;
        const fullTarget = latestN > FULL_LOOKBACK ? latestN - FULL_LOOKBACK : 0n;

        // Phase 1: fast window
        await scanWindow(latestN, fastTarget);
        if (!cancelled) {
          setByToken(new Map(tokensMap));
          setByDay(new Map(daysMap));
          setScanning(false);
        }

        // Phase 2: extend in background
        if (fastTarget > fullTarget && !cancelled) {
          await scanWindow(fastTarget > 0n ? fastTarget - 1n : 0n, fullTarget);
          if (!cancelled) {
            setByToken(new Map(tokensMap));
            setByDay(new Map(daysMap));
          }
        }
        if (!cancelled) setFullyLoaded(true);
      } catch {
        if (!cancelled) {
          setByToken(new Map());
          setByDay(new Map());
          setScanning(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, account, mine]);

  const result = useMemo<CreatorEarningsResult>(() => {
    const perToken = Array.from(byToken.values()).sort((a, b) => b.amountUsd - a.amountUsd);
    const claimedUsd = perToken.reduce((acc, t) => acc + t.amountUsd, 0);
    // Build daily series filling gaps with 0 so the sparkline is continuous.
    // Window spans from the oldest day we saw data through today, capped to
    // MAX_CHART_DAYS so old tokens with months of history don't make the
    // sparkline unreadable.
    const now = Math.floor(Date.now() / 1000);
    const today = Math.floor(now / DAY_SECONDS) * DAY_SECONDS;
    let oldestDay = today;
    for (const day of byDay.keys()) {
      if (day < oldestDay) oldestDay = day;
    }
    const earliestAllowed = today - (MAX_CHART_DAYS - 1) * DAY_SECONDS;
    if (oldestDay < earliestAllowed) oldestDay = earliestAllowed;
    const windowDays =
      Math.max(1, Math.floor((today - oldestDay) / DAY_SECONDS) + 1);
    const daily: DailyEarnings[] = [];
    for (let i = windowDays - 1; i >= 0; i--) {
      const day = today - i * DAY_SECONDS;
      daily.push({ daySeconds: day, amountUsd: byDay.get(day) ?? 0 });
    }
    return {
      claimedUsd,
      pendingUsd,
      perToken,
      daily,
      fullyLoaded,
      isLoading: tokensLoading || scanning || previewCalls.isLoading,
    };
  }, [byToken, byDay, pendingUsd, fullyLoaded, tokensLoading, scanning, previewCalls.isLoading]);

  return result;
}
