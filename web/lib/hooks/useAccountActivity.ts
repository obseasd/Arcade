import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { ActivityEntry } from "@/lib/activityFeed";

/**
 * Per-wallet recent activity from the Goldsky subgraph `Trade` entity, queried
 * by `trader`. This is the cross-device / backend-visible source the personal
 * activity feed was missing: the localStorage log only ever sees actions taken
 * in THIS browser, so a trade made on another device (or a keeper/backend fill)
 * never showed up. The subgraph already indexes every trade with the trader
 * address, so we read the wallet's recent trades here and merge them into both
 * feed surfaces (HeaderWalletWidget + /my-tokens), de-duplicated by txHash.
 *
 * Field names mirror the shapes already in use: `useTokenTrades` derives the tx
 * hash from `id` (`${txHash}-${logIndex}`) since the Trade entity has no
 * standalone txHash column; `volumeUsdc` is whole USDC; `isBuy` discriminates
 * buy vs sell. Symbols come from a second `tokens` lookup (Token.symbol), which
 * soft-fails independently so a missing symbol just drops the label decoration.
 *
 * Everything soft-fails to [] (missing GOLDSKY_URL, network error, malformed
 * payload) so this can only ADD rows to the feed, never break the existing
 * localStorage path.
 */
export interface AccountActivityItem {
  type: "buy" | "sell";
  token: Address;
  symbol?: string;
  /** Whole USDC value of the trade (the USDC leg). */
  valueUsdc: number;
  /** Unix seconds. */
  blockTime: number;
  txHash: `0x${string}`;
}

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

/** Cap the per-wallet history so the feed stays light. */
const MAX_ITEMS = 50;

interface TradeRow {
  id: string;
  token: string;
  isBuy: boolean;
  volumeUsdc: string | number;
  blockTime: string | number;
}

async function fetchAccountTrades(account: string): Promise<AccountActivityItem[]> {
  if (!GOLDSKY_URL) return [];
  const acct = account.toLowerCase();
  const q = `{ trades(first: ${MAX_ITEMS}, orderBy: blockNumber, orderDirection: desc, where: { trader: "${acct}" }) { id token isBuy volumeUsdc blockTime } }`;
  try {
    const res = await fetch(GOLDSKY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { trades?: TradeRow[] } };
    const rows = json?.data?.trades;
    if (!Array.isArray(rows)) return [];

    const items: AccountActivityItem[] = [];
    for (const r of rows) {
      const txHash = (r.id?.split("-")[0] ?? "") as `0x${string}`;
      if (!txHash.startsWith("0x")) continue;
      const valueUsdc = Number(r.volumeUsdc);
      const blockTime = Number(r.blockTime);
      if (!isFinite(valueUsdc) || !isFinite(blockTime)) continue;
      items.push({
        type: r.isBuy ? "buy" : "sell",
        token: (r.token as Address),
        valueUsdc,
        blockTime,
        txHash,
      });
    }

    // Resolve symbols for the distinct tokens in one follow-up query. This is a
    // soft enrichment: any failure just leaves `symbol` undefined.
    const distinct = Array.from(new Set(items.map((i) => i.token.toLowerCase())));
    if (distinct.length > 0) {
      try {
        const idList = distinct.map((t) => `"${t}"`).join(", ");
        const sq = `{ tokens(where: { id_in: [${idList}] }) { id symbol } }`;
        const sres = await fetch(GOLDSKY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: sq }),
        });
        if (sres.ok) {
          const sjson = (await sres.json()) as {
            data?: { tokens?: Array<{ id: string; symbol: string | null }> };
          };
          const bySymbol = new Map<string, string>();
          for (const t of sjson?.data?.tokens ?? []) {
            if (t?.id && t.symbol) bySymbol.set(t.id.toLowerCase(), t.symbol);
          }
          for (const i of items) {
            const s = bySymbol.get(i.token.toLowerCase());
            if (s) i.symbol = s;
          }
        }
      } catch {
        /* symbols are optional; ignore */
      }
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * React-query hook: the connected wallet's recent trades from the subgraph,
 * newest-first, capped at 50. Polls every ~15s. Returns [] until data lands and
 * on any error, so callers can unconditionally spread it into their feed.
 */
export function useAccountActivity(account: Address | undefined): AccountActivityItem[] {
  const acct = account?.toLowerCase();
  const { data } = useQuery<AccountActivityItem[]>({
    queryKey: ["arcade", "account-activity", acct ?? null],
    enabled: !!GOLDSKY_URL && !!acct,
    staleTime: 15_000,
    refetchInterval: 15_000,
    queryFn: () => (acct ? fetchAccountTrades(acct) : Promise.resolve([])),
  });
  return data ?? [];
}

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * Adapt a subgraph activity item to the localStorage `ActivityEntry` shape so
 * both feed surfaces can render it through their existing app-activity row and
 * merge it with the localStorage log de-duplicated by txHash. The id is derived
 * from the txHash so re-renders are stable and cross-source dedup by txHash is
 * exact.
 */
export function accountActivityToEntry(
  item: AccountActivityItem,
  account: string,
): ActivityEntry {
  const name = item.symbol ? `$${item.symbol}` : shortAddr(item.token);
  return {
    id: `sg-${item.txHash}`,
    type: item.type,
    timestamp: item.blockTime * 1000,
    account: account.toLowerCase(),
    token: item.token,
    label: item.type === "buy" ? `Bought ${name}` : `Sold ${name}`,
    value: `${item.valueUsdc.toFixed(2)} USDC`,
    txHash: item.txHash,
  };
}
