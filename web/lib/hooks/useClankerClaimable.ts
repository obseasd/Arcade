"use client";

import { useEffect, useMemo } from "react";
import { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { ADDRESSES } from "@/lib/constants";

export interface ClaimablePreview {
  /** Pending paired-token amount (USDC or WETH raw units) across all ranges. */
  pairedRaw: bigint;
  /** Pending clanker-token amount (18-dec raw units) across all ranges. */
  clankerRaw: bigint;
  /** True while reads are pending. */
  isLoading: boolean;
}

/**
 * Reads the locker's `previewFees(positionId)` view, which sums pending fees
 * across all ranges via the Uniswap V3 fee growth math on-chain. One read
 * replaces the 13+ pool reads we used to do client-side.
 *
 * Polls every 15s so accrued fees stay current. Pass `refreshKey` (bumped on
 * Swap events by the token page's WebSocket subscription) for an immediate
 * refetch right after a trade rather than waiting for the next poll.
 */
export function useClankerClaimable(token: Address | undefined, refreshKey?: number): ClaimablePreview {
  const posIdQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "positionIdByToken",
    args: token ? [token] : undefined,
    query: {
      enabled: !!token && ADDRESSES.v3Locker !== "0x0000000000000000000000000000000000000000",
    },
  });
  const positionId = (posIdQ.data as bigint | undefined) ?? 0n;

  const previewQ = useReadContracts({
    contracts: positionId > 0n
      ? [
          {
            address: ADDRESSES.v3Locker,
            abi: V3_LOCKER_ABI,
            functionName: "previewFees" as const,
            args: [positionId] as const,
          },
        ]
      : [],
    // Poll on a 15s interval so the panel stays current without a page
    // refresh as new swaps accrue fees in the locked V3 position.
    // Audit 2026-06-18b rpc-efficiency: refetchIntervalInBackground is
    // false (react-query default, made explicit here) so the 15s poll
    // pauses while the tab is backgrounded — no RPC burn on a token
    // page left open in an inactive tab.
    query: {
      enabled: positionId > 0n,
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
    },
  });

  // When the parent bumps refreshKey (eg a live Swap arrived) re-pull fees
  // immediately instead of waiting up to 15s for the polling interval.
  useEffect(() => {
    if (refreshKey === undefined) return;
    previewQ.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return useMemo<ClaimablePreview>(() => {
    if (!previewQ.data || previewQ.data.length === 0) {
      return { pairedRaw: 0n, clankerRaw: 0n, isLoading: posIdQ.isLoading || previewQ.isLoading };
    }
    const r = previewQ.data[0]?.result as readonly [bigint, bigint] | undefined;
    if (!r) return { pairedRaw: 0n, clankerRaw: 0n, isLoading: false };
    return { pairedRaw: r[0], clankerRaw: r[1], isLoading: false };
  }, [previewQ.data, previewQ.isLoading, posIdQ.isLoading]);
}
