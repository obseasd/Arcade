import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

/**
 * The graduation milestone for a token, from the Goldsky subgraph `Graduation`
 * entity (written by handleGraduatedV4, one row per Graduated event). Queried by
 * token address so the activity feed can show a "graduated to the AMM" row
 * alongside trades and claims. At most one per token.
 *
 * NOTE: requires the subgraph deploy that adds the `Graduation` entity; until
 * then the query returns nothing (soft-fails), so the feed just omits the row.
 */
export interface GraduationRow {
  txHash: `0x${string}`;
  usdcRaised: number;
  blockTime: number;
}

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

export function useTokenGraduation(token: Address | undefined, enabled = true): GraduationRow | null {
  const tokenKey = token?.toLowerCase();
  const { data } = useQuery<GraduationRow | null>({
    queryKey: ["arcade", "token-graduation", tokenKey ?? null],
    enabled: enabled && !!GOLDSKY_URL && !!tokenKey,
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!GOLDSKY_URL || !tokenKey) return null;
      const q = `{ graduations(first: 1, orderBy: blockNumber, orderDirection: desc, where: { token: "${tokenKey}" }) { txHash usdcRaised blockTime } }`;
      try {
        const res = await fetch(GOLDSKY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as {
          data?: { graduations?: Array<{ txHash: string; usdcRaised: string | number; blockTime: string | number }> };
        };
        const g = json?.data?.graduations?.[0];
        if (!g) return null;
        return {
          txHash: g.txHash as `0x${string}`,
          usdcRaised: Number(g.usdcRaised) || 0,
          blockTime: Number(g.blockTime) || 0,
        };
      } catch {
        return null;
      }
    },
  });
  return data ?? null;
}
