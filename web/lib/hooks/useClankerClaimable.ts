"use client";

import { useMemo } from "react";
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
 */
export function useClankerClaimable(token: Address | undefined): ClaimablePreview {
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
    query: { enabled: positionId > 0n },
  });

  return useMemo<ClaimablePreview>(() => {
    if (!previewQ.data || previewQ.data.length === 0) {
      return { pairedRaw: 0n, clankerRaw: 0n, isLoading: posIdQ.isLoading || previewQ.isLoading };
    }
    const r = previewQ.data[0]?.result as readonly [bigint, bigint] | undefined;
    if (!r) return { pairedRaw: 0n, clankerRaw: 0n, isLoading: false };
    return { pairedRaw: r[0], clankerRaw: r[1], isLoading: false };
  }, [previewQ.data, previewQ.isLoading, posIdQ.isLoading]);
}
