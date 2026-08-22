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
  // The TOKEN leg, joined from the TokenForward entity by (claimTxHash, slotIndex)
  // when the TokenFeeForwarder is live. undefined for legacy claims whose token
  // leg was a bare transfer with no on-chain marker.
  amountToken?: number;
}

const GOLDSKY_URL = process.env.NEXT_PUBLIC_GOLDSKY_URL;

export function useTokenClaims(positionId: bigint | undefined, enabled = true): ClaimRow[] {
  const { data } = useQuery<ClaimRow[]>({
    queryKey: ["arcade", "token-claims", positionId?.toString() ?? null],
    enabled: enabled && !!GOLDSKY_URL && positionId !== undefined && positionId > 0n,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!GOLDSKY_URL || positionId === undefined) return [];
      const pid = positionId.toString();
      // Fetch the USDC-side claims AND the token-leg forwards for this pool, then
      // join by (claimTxHash, slotIndex). amountRaw is the RAW token amount
      // (18-dp launch token) -- format by /1e18, never the USDC 1e6 convention.
      const q = `{
        claims(first: 100, orderBy: blockNumber, orderDirection: desc, where: { positionId: "${pid}" }) { txHash recipient amountUsdc blockTime slotIndex }
        tokenForwards(first: 100, where: { positionId: "${pid}" }) { claimTxHash slotIndex recipient amountRaw }
      }`;
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
            tokenForwards?: Array<{ claimTxHash: string; slotIndex: string | number; recipient: string; amountRaw: string }>;
          };
        };
        // Index token legs by claimTxHash-slotIndex-recipient for an O(1) join. The
        // recipient is part of the key as defense-in-depth: a token leg only labels a
        // claim if it went to the SAME wallet the claim paid (so a hypothetical
        // compromised allowed-caller can't graft a spoofed +amount onto a claim it
        // didn't fund). Legs whose claimTxHash is ZERO_BYTES32 (cron fallback) key on
        // 0x000..0 and never collide with a real claim tx.
        const legs = new Map<string, number>();
        for (const f of json?.data?.tokenForwards ?? []) {
          const key = `${f.claimTxHash.toLowerCase()}-${Number(f.slotIndex)}-${f.recipient.toLowerCase()}`;
          legs.set(key, Number(f.amountRaw) / 1e18);
        }
        return (json?.data?.claims ?? []).map((c) => {
          const amountToken = legs.get(`${c.txHash.toLowerCase()}-${Number(c.slotIndex)}-${c.recipient.toLowerCase()}`);
          return {
            txHash: c.txHash as `0x${string}`,
            recipient: c.recipient as Address,
            amountUsdc: Number(c.amountUsdc),
            blockTime: Number(c.blockTime),
            slotIndex: Number(c.slotIndex),
            amountToken,
          };
        });
      } catch {
        return [];
      }
    },
  });
  return data ?? [];
}
