"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

export interface V4TokenStats {
  /** Latest USDC-per-token price (subgraph), or undefined if never traded. */
  priceUsd?: number;
  /** Sum of USDC volume across the token's (recent) V4 trades. */
  totalVolumeUsdc: number;
  /** USDC currently in the pool = net USDC bought (buys - sells). CLANKER seeds
   *  the pool single-sided with TOKENS only, so all USDC-side liquidity comes
   *  from net buying; this is the tradeable USDC depth. Floored at 0. */
  usdcLiquidity: number;
  isLoading: boolean;
}

/**
 * Aggregate on-page stats for an ArcadeHook (V4) token, sourced from the Goldsky
 * subgraph: the latest trade price (for market cap) and the cumulative traded
 * USDC volume (for the fees-generated figure). Polls every 15s so market cap
 * and fees stay live without a manual refresh. Volume sums the most recent 1000
 * trades (a FLOOR for very busy tokens, exact for everything else).
 */
export function useV4TokenStats(token: Address | undefined): V4TokenStats {
  const tokenKey = token?.toLowerCase();
  const { data, isLoading, isFetching } = useQuery<{ priceUsd?: number; totalVolumeUsdc: number; usdcLiquidity: number }>({
    queryKey: ["arcade", "v4-token-stats", tokenKey],
    enabled: !!GOLDSKY_URL && !!tokenKey,
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!GOLDSKY_URL || !tokenKey) return { totalVolumeUsdc: 0, usdcLiquidity: 0 };
      const q = `{
        latest: trades(first: 1, orderBy: blockNumber, orderDirection: desc, where: { token: "${tokenKey}", source: "v4" }) { price }
        vol: trades(first: 1000, orderBy: blockNumber, orderDirection: desc, where: { token: "${tokenKey}", source: "v4" }) { volumeUsdc isBuy }
      }`;
      const res = await fetch(GOLDSKY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) return { totalVolumeUsdc: 0, usdcLiquidity: 0 };
      const json = (await res.json()) as {
        data?: {
          latest?: { price: string | number }[];
          vol?: { volumeUsdc: string | number; isBuy: boolean }[];
        };
      };
      const p = Number(json?.data?.latest?.[0]?.price);
      let totalVolumeUsdc = 0;
      let netUsdc = 0;
      for (const r of json?.data?.vol ?? []) {
        const v = Number(r.volumeUsdc || 0);
        if (!Number.isFinite(v)) continue;
        totalVolumeUsdc += v;
        netUsdc += r.isBuy ? v : -v;
      }
      return {
        priceUsd: Number.isFinite(p) && p > 0 ? p : undefined,
        totalVolumeUsdc,
        usdcLiquidity: Math.max(0, netUsdc),
      };
    },
  });
  return {
    priceUsd: data?.priceUsd,
    totalVolumeUsdc: data?.totalVolumeUsdc ?? 0,
    usdcLiquidity: data?.usdcLiquidity ?? 0,
    isLoading: isLoading || isFetching,
  };
}
