import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

/**
 * Creator-fee claims for a token, from the Goldsky subgraph `Claim` entity
 * (written by handleEscrowClaimed, one row per escrow Claimed event). Queried by
 * positionId = uint256(poolId), which the token page derives from poolIdOf. Used
 * to interleave "claimed $X" rows into the activity feed alongside trades.
 *
 * NOTE: requires the subgraph deploy that adds the `Claim` entity; until then the
 * query returns nothing (soft-fails), so the feed just shows trades.
 */
export interface ClaimRow {
  txHash: `0x${string}`;
  recipient: Address;
  amountUsdc: number;
  blockTime: number;
  slotIndex: number;
}

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

export function useTokenClaims(positionId: bigint | undefined, enabled = true): ClaimRow[] {
  const { data } = useQuery<ClaimRow[]>({
    queryKey: ["arcade", "token-claims", positionId?.toString() ?? null],
    enabled: enabled && !!GOLDSKY_URL && positionId !== undefined && positionId > 0n,
    staleTime: 15_000,
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!GOLDSKY_URL || positionId === undefined) return [];
      const q = `{ claims(first: 100, orderBy: blockNumber, orderDirection: desc, where: { positionId: "${positionId.toString()}" }) { txHash recipient amountUsdc blockTime slotIndex } }`;
      try {
        const res = await fetch(GOLDSKY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        if (!res.ok) return [];
        const json = (await res.json()) as {
          data?: {
            claims?: Array<{ txHash: string; recipient: string; amountUsdc: string | number; blockTime: string | number; slotIndex: string | number }>;
          };
        };
        return (json?.data?.claims ?? []).map((c) => ({
          txHash: c.txHash as `0x${string}`,
          recipient: c.recipient as Address,
          amountUsdc: Number(c.amountUsdc),
          blockTime: Number(c.blockTime),
          slotIndex: Number(c.slotIndex),
        }));
      } catch {
        return [];
      }
    },
  });
  return data ?? [];
}
