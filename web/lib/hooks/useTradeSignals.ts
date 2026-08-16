"use client";

import { useQuery } from "@tanstack/react-query";

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

export interface TradeSignals {
    /** token address (lowercase) -> trailing 1h traded volume in USD. */
    vol1h: Map<string, number>;
    /** token address (lowercase) -> unix seconds of its most recent trade. */
    lastTradeAt: Map<string, number>;
}

/**
 * Derives two launchpad sort signals from the subgraph `Trade` entity in a SINGLE
 * query -- no schema change needed, because Trade already carries `blockTime`
 * (unix seconds) + `token` + `volumeUsdc`:
 *   - vol1h:        exact trailing-1h volume per token (Trending).
 *   - lastTradeAt:  each token's most recent trade time (All / Migrated order).
 *
 * Pulls the 1000 most-recent trades (desc by blockTime). Active tokens -- the
 * ones these sorts care about -- are all in that window; a token whose last trade
 * predates it is inactive and correctly falls to the bottom (no lastTradeAt).
 */
export function useTradeSignals(): TradeSignals {
    const { data } = useQuery<TradeSignals>({
        queryKey: ["arcade", "tradeSignals"],
        enabled: !!GOLDSKY_URL,
        refetchInterval: 30_000,
        staleTime: 15_000,
        queryFn: async () => {
            const vol1h = new Map<string, number>();
            const lastTradeAt = new Map<string, number>();
            try {
                const q = `{ trades(first: 1000, orderBy: blockTime, orderDirection: desc) { token volumeUsdc blockTime } }`;
                const res = await fetch(GOLDSKY_URL as string, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ query: q }),
                });
                if (!res.ok) return { vol1h, lastTradeAt };
                const json = (await res.json()) as {
                    data?: { trades?: { token: string; volumeUsdc: string; blockTime: number }[] };
                };
                const cutoff = Math.floor(Date.now() / 1000) - 3600;
                for (const t of json?.data?.trades ?? []) {
                    if (!t.token) continue;
                    const key = t.token.toLowerCase();
                    const bt = Number(t.blockTime) || 0;
                    // desc-ordered, so the FIRST time we see a token is its most recent trade.
                    if (!lastTradeAt.has(key)) lastTradeAt.set(key, bt);
                    if (bt >= cutoff) vol1h.set(key, (vol1h.get(key) ?? 0) + (Number(t.volumeUsdc) || 0));
                }
            } catch {
                /* leave the maps empty on any failure */
            }
            return { vol1h, lastTradeAt };
        },
    });
    return data ?? { vol1h: new Map(), lastTradeAt: new Map() };
}
