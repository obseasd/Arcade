"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { V4TokenStats } from "./useV4TokenStats";

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

const TOKEN_FIELDS = "totalVolumeUsdc feesUsdc lastPriceUsdc usdcLiquidity createdAt metadataURI";

export type V4StatsMap = Map<string, Omit<V4TokenStats, "isLoading">>;

/**
 * Batch-fetch V4 token stats for ALL addresses in one GraphQL request
 * (aliased Token entity reads). Replaces N per-card useV4TokenStats calls
 * with a single POST every 15s.
 */
export function useV4TokenStatsBatch(tokens: Address[]): { statsMap: V4StatsMap; isLoading: boolean } {
  const keys = tokens.map((t) => t.toLowerCase());

  const { data, isLoading } = useQuery<V4StatsMap>({
    queryKey: ["arcade", "v4-token-stats-batch", ...keys],
    enabled: !!GOLDSKY_URL && keys.length > 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const map: V4StatsMap = new Map();
      if (!GOLDSKY_URL || keys.length === 0) return map;

      const aliases = keys.map((k, i) => {
        const alias = `t${i}`;
        return `${alias}: token(id: "${k}") { ${TOKEN_FIELDS} }`;
      });
      const q = `{ ${aliases.join("\n")} }`;

      try {
        const res = await fetch(GOLDSKY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        if (!res.ok) return map;
        const json = (await res.json()) as { data?: Record<string, {
          totalVolumeUsdc?: string; feesUsdc?: string; lastPriceUsdc?: string;
          usdcLiquidity?: string; createdAt?: string | number; metadataURI?: string;
        } | null> };

        for (let i = 0; i < keys.length; i++) {
          const t = json?.data?.[`t${i}`];
          if (!t || t.totalVolumeUsdc == null) continue;
          const price = Number(t.lastPriceUsdc);
          map.set(keys[i], {
            priceUsd: Number.isFinite(price) && price > 0 ? price : undefined,
            totalVolumeUsdc: Number(t.totalVolumeUsdc) || 0,
            usdcLiquidity: Math.max(0, Number(t.usdcLiquidity) || 0),
            feesUsdc: t.feesUsdc != null ? Number(t.feesUsdc) : undefined,
            createdAtSec: Number(t.createdAt) || 0,
            metadataURI: t.metadataURI || undefined,
          });
        }
      } catch {
        // network error; return empty map so per-card fallbacks fire
      }
      return map;
    },
  });

  return { statsMap: data ?? new Map(), isLoading };
}
