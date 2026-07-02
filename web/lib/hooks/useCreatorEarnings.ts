"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Address } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { RECIPIENT_PAID_EVT } from "@/lib/eventSignatures";
import { CHUNK_LARGE } from "@/lib/eventScan";
import { useV3Tokens } from "./useV3Tokens";

const CHUNK = CHUNK_LARGE;
/**
 * Single-phase scan window (~5.8 days at 1s block time). Until we have an
 * indexer, walking more than this per page load is not viable. Captures the
 * relevant window for any active creator on testnet today.
 */
const SCAN_LOOKBACK = 500_000n;
const DAY_SECONDS = 86_400;
/** Max days the sparkline ever displays even if there's older data. */
const MAX_CHART_DAYS = 30;

const SCAN_STALE_MS = 5 * 60_000;
const PREVIEW_REFETCH_MS = 30_000;

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
  /** Whether the historical scan has completed. */
  fullyLoaded: boolean;
  isLoading: boolean;
}

interface CreatorPosition {
  token: Address;
  positionId: bigint;
  symbol?: string;
}

interface ScanAggregate {
  byToken: Map<string, TokenEarnings>;
  byDay: Map<number, number>;
}

/**
 * Aggregates V3 locker LP fee claims paid to the connected wallet over the
 * recent past, plus pending (unclaimed) preview amounts.
 *
 * React-Query-backed: dedupes the chunked RecipientPaid scan across renders
 * and caches it for 5 minutes (audit ARCH-007). Per-position previewFees runs
 * on a 30s polling interval and is also RQ-managed via wagmi's
 * useReadContracts.
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

  // 2) Recipients per position; filter to ones where the wallet is involved.
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
        out.push({
          token: v3Tokens[i].address,
          positionId: positionIds[i],
          symbol: v3Tokens[i].symbol,
        });
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
    query: { enabled: mine.length > 0, refetchInterval: PREVIEW_REFETCH_MS },
  });

  // Resolve each position's paired token so pendingUsd only treats the
  // paired side as USD 1:1 when it is actually USDC. previewFees returns the
  // paired amount in the paired token's native units, which is USDC (6 dp)
  // for standard/deep/legacy pools but WETH (18 dp) for the weth pool type.
  // Dividing a WETH amount by 1e6 (fee audit 2026-07-02 LOW-2) blew the
  // pending figure up by ~1e12 (a few dollars showed as ~$1B). We mirror the
  // historical scan, which contributes 0 USD for non-USDC payouts.
  const posInfoCalls = useReadContracts({
    contracts: mine.map((p) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "getPosition" as const,
      args: [p.positionId] as const,
    })),
    query: { enabled: mine.length > 0 },
  });

  const pendingUsd = useMemo(() => {
    if (!previewCalls.data) return 0;
    const usdc = ADDRESSES.usdc.toLowerCase();
    let sum = 0n;
    for (let i = 0; i < previewCalls.data.length; i++) {
      const r = previewCalls.data[i];
      if (r?.status !== "success") continue;
      const info = posInfoCalls.data?.[i];
      // Skip until we know the paired token; counting it before we can
      // confirm it is USDC is what produced the ~$1B WETH artifact.
      if (info?.status !== "success") continue;
      const pairedToken = (
        info.result as { pairedToken?: Address } | undefined
      )?.pairedToken;
      if (!pairedToken || pairedToken.toLowerCase() !== usdc) continue;
      const [paired] = r.result as readonly [bigint, bigint];
      sum += paired;
    }
    return Number(sum) / 10 ** USDC_DECIMALS;
  }, [previewCalls.data, posInfoCalls.data]);

  // 4) Historical claims via RQ-cached chunked scan. Stable key for the set
  // of positions we scan; without this, wagmi refetches would flip object
  // identities in `mine` and invalidate the query every 30s.
  const mineKey = useMemo(
    () =>
      mine
        .map((p) => `${p.positionId.toString()}-${p.token.toLowerCase()}`)
        .sort()
        .join(","),
    [mine],
  );

  const scanQuery = useQuery<ScanAggregate>({
    queryKey: [
      "arcade",
      "creator-earnings-scan",
      account?.toLowerCase() ?? null,
      mineKey,
    ],
    enabled: !!publicClient && !!account && mine.length > 0,
    staleTime: SCAN_STALE_MS,
    gcTime: SCAN_STALE_MS * 5,
    queryFn: async () => {
      const tokensMap = new Map<string, TokenEarnings>();
      const daysMap = new Map<number, number>();
      if (!publicClient || !account || mine.length === 0) {
        return { byToken: tokensMap, byDay: daysMap };
      }
      try {
        const latest = await publicClient.getBlock();
        const latestN = latest.number as bigint;
        const latestTs = Number(latest.timestamp);
        const acc = account.toLowerCase();
        const target = latestN > SCAN_LOOKBACK ? latestN - SCAN_LOOKBACK : 0n;

        const perPositionWalks = mine.map(async (p) => {
          let cursor = latestN;
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
                const ts =
                  latestTs - Number(latestN - (log.blockNumber as bigint));

                const prev = tokensMap.get(tokenAddr);
                const amountUsd = isUsdc
                  ? Number(amount) / 10 ** USDC_DECIMALS
                  : 0;
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
      } catch (err) {
        // creator-earnings-swallowed-errors-hide-rpc-failure: surface
        // to the dev console + rethrow so React Query flips into error
        // state. The previous bare-swallow let an RPC outage masquerade
        // as "fullyLoaded with $0 earned", which silently lied to the
        // user.
        // eslint-disable-next-line no-console
        console.warn("[useCreatorEarnings] scan error:", err);
        throw err;
      }
      return { byToken: tokensMap, byDay: daysMap };
    },
  });

  const byToken = scanQuery.data?.byToken ?? new Map<string, TokenEarnings>();
  const byDay = scanQuery.data?.byDay ?? new Map<number, number>();
  const scanning = scanQuery.isLoading || scanQuery.isFetching;
  const fullyLoaded = scanQuery.isSuccess && !scanning;

  return useMemo<CreatorEarningsResult>(() => {
    const perToken = Array.from(byToken.values()).sort(
      (a, b) => b.amountUsd - a.amountUsd,
    );
    const claimedUsd = perToken.reduce((acc, t) => acc + t.amountUsd, 0);
    const now = Math.floor(Date.now() / 1000);
    const today = Math.floor(now / DAY_SECONDS) * DAY_SECONDS;
    let oldestDay = today;
    for (const day of byDay.keys()) {
      if (day < oldestDay) oldestDay = day;
    }
    const earliestAllowed = today - (MAX_CHART_DAYS - 1) * DAY_SECONDS;
    if (oldestDay < earliestAllowed) oldestDay = earliestAllowed;
    const windowDays = Math.max(
      1,
      Math.floor((today - oldestDay) / DAY_SECONDS) + 1,
    );
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
  }, [
    byToken,
    byDay,
    pendingUsd,
    fullyLoaded,
    tokensLoading,
    scanning,
    previewCalls.isLoading,
  ]);
}
