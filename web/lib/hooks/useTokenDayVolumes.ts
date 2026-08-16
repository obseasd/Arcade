"use client";

import { useQuery } from "@tanstack/react-query";

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

/**
 * Map of lowercase token address -> its 24h traded volume in USD, from the
 * subgraph TokenDayData (current UTC-day bucket). One query covers every token
 * on the page. Empty when the subgraph URL is unset. Note: this is the current
 * UTC day (resets at midnight), the standard daily-bucket approximation of "24h
 * volume"; a true rolling window would need an hourly entity (Tier 2).
 */
export function useTokenDayVolumes(): { volMap: Map<string, number> } {
    const { data } = useQuery<Map<string, number>>({
        queryKey: ["arcade", "tokenDayVolumes"],
        enabled: !!GOLDSKY_URL,
        refetchInterval: 60_000,
        staleTime: 30_000,
        queryFn: async () => {
            const map = new Map<string, number>();
            const dayStart = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
            try {
                const q = `{ tokenDayDatas(first: 1000, where: { date: ${dayStart} }) { token volumeUsdc } }`;
                const res = await fetch(GOLDSKY_URL as string, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ query: q }),
                });
                if (!res.ok) return map;
                const json = (await res.json()) as {
                    data?: { tokenDayDatas?: { token: string; volumeUsdc: string }[] };
                };
                for (const d of json?.data?.tokenDayDatas ?? []) {
                    if (d.token) map.set(d.token.toLowerCase(), Number(d.volumeUsdc) || 0);
                }
            } catch {
                /* leave the map empty on any failure */
            }
            return map;
        },
    });
    return { volMap: data ?? new Map() };
}
