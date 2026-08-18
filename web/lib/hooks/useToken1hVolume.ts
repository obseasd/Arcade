"use client";

import { useQuery } from "@tanstack/react-query";

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

/**
 * Trailing-1h traded volume (USD) for ONE token, from the subgraph Trade entity
 * (which carries blockTime + volumeUsdc). A targeted per-token query -- unlike
 * useTradeSignals which pulls the 1000 most-recent trades globally for the
 * launchpad sorts. Returns 0 while loading / on any failure.
 */
export function useToken1hVolumeUsd(token: string | undefined): number {
    const key =
        token && /^0x[0-9a-fA-F]{40}$/.test(token) ? token.toLowerCase() : undefined;
    const { data } = useQuery<number>({
        queryKey: ["arcade", "token1hVol", key],
        enabled: !!GOLDSKY_URL && !!key,
        refetchInterval: 30_000,
        staleTime: 15_000,
        queryFn: async () => {
            const cutoff = Math.floor(Date.now() / 1000) - 3600;
            const q = `{ trades(first: 1000, orderBy: blockTime, orderDirection: desc, where: { token: "${key}", blockTime_gte: ${cutoff} }) { volumeUsdc } }`;
            try {
                const res = await fetch(GOLDSKY_URL as string, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ query: q }),
                });
                if (!res.ok) return 0;
                const json = (await res.json()) as {
                    data?: { trades?: { volumeUsdc: string }[] };
                };
                let sum = 0;
                for (const t of json?.data?.trades ?? []) sum += Number(t.volumeUsdc) || 0;
                return sum;
            } catch {
                return 0;
            }
        },
    });
    return data ?? 0;
}
