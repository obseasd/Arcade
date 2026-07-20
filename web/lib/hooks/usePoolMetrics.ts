"use client";

import { useQuery } from "@tanstack/react-query";
import { Address, zeroAddress } from "viem";

/**
 * Per-pool 24h Volume / Fees / TVL / APR from the ArcLens (Goldsky) subgraph.
 * Reads the pool's latest PoolDayData bucket (volume + fees) and Pool.usdcReserve
 * (TVL = usdcReserve x 2). APR = feesUsdc annualised over TVL. Returns undefined
 * fields while loading or when a pool has no indexed activity yet, so callers can
 * render a dash. Replaces the hardcoded placeholders on the V2/V3 position cards.
 */
export interface PoolMetrics {
    volUsd?: number;
    feesUsd?: number;
    tvlUsd?: number;
    aprPct?: number;
}

export function usePoolMetrics(pool: Address | undefined): PoolMetrics {
    const { data } = useQuery<PoolMetrics>({
        queryKey: ["arcade", "pool-metrics", pool?.toLowerCase() ?? null],
        enabled: !!process.env.NEXT_PUBLIC_GOLDSKY_URL && !!pool && pool !== zeroAddress,
        staleTime: 30_000,
        refetchInterval: 60_000,
        queryFn: async () => {
            const url = process.env.NEXT_PUBLIC_GOLDSKY_URL as string;
            const id = (pool as Address).toLowerCase();
            const q = `{
                poolDayDatas(first: 1, orderBy: date, orderDirection: desc, where: { pool: "${id}" }) { volumeUsdc feesUsdc }
                pool(id: "${id}") { usdcReserve }
            }`;
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query: q }),
            });
            if (!res.ok) return {};
            const j = (await res.json()) as {
                data?: {
                    poolDayDatas?: { volumeUsdc: string; feesUsdc: string }[];
                    pool?: { usdcReserve: string } | null;
                };
            };
            const d = j?.data?.poolDayDatas?.[0];
            const reserve = Number(j?.data?.pool?.usdcReserve) || 0;
            const tvlUsd = reserve > 0 ? reserve * 2 : undefined;
            const volUsd = d ? Number(d.volumeUsdc) || 0 : undefined;
            const feesUsd = d ? Number(d.feesUsdc) || 0 : undefined;
            const aprPct =
                feesUsd !== undefined && tvlUsd && tvlUsd > 0
                    ? (feesUsd * 365 * 100) / tvlUsd
                    : undefined;
            return { volUsd, feesUsd, tvlUsd, aprPct };
        },
    });
    return data ?? {};
}
