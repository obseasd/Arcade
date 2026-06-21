"use client";

import { useMemo } from "react";
import { Address } from "viem";
import { useReadContracts } from "wagmi";
import { V3_POOL_ABI } from "@/lib/abis/v3";
import { ADDRESSES, LAUNCHPAD_TOKEN_DECIMALS, LAUNCHPAD_TOTAL_SUPPLY } from "@/lib/constants";

const Q192 = 2n ** 192n;
const TOTAL_SUPPLY_RAW = LAUNCHPAD_TOTAL_SUPPLY * 10n ** BigInt(LAUNCHPAD_TOKEN_DECIMALS);
const ZERO = "0x0000000000000000000000000000000000000000";

function computeFdv(sqrtPriceX96: bigint, token0: Address, clanker: Address): bigint {
  const isClankerToken0 = token0.toLowerCase() === clanker.toLowerCase();
  const num = sqrtPriceX96 * sqrtPriceX96;
  return isClankerToken0 ? (TOTAL_SUPPLY_RAW * num) / Q192 : (TOTAL_SUPPLY_RAW * Q192) / num;
}

interface ClankerInput {
  address: Address;
  mode: number;
  /** The CLANKER_V3 pool (stored as v2Pair on LaunchpadTokenInfo). */
  v2Pair?: Address;
}

/**
 * Batch-reads slot0/token0/token1 for every CLANKER_V3 pool in the list
 * and returns a map of clanker-address (lowercased) -> implied FDV in
 * USDC micros, but ONLY for USDC-paired clankers (whose FDV is already in
 * USDC and therefore directly comparable to a bonding-curve token's
 * realUsdcReserve in the launchpad sort).
 *
 * Why: a Clanker has no bonding curve, so its `realUsdcReserve` is 0 and
 * it always sorted last on /launchpad even at a 35k mcap. Non-USDC pairs
 * (e.g. WETH) are omitted — converting them needs a price oracle we don't
 * carry here — so the caller falls back to 0 for those (unchanged
 * behaviour). One multicall for the whole grid.
 */
export function useClankerSortMcaps(tokens: ClankerInput[]): Map<string, bigint> {
  const clankers = useMemo(
    () =>
      tokens.filter(
        (t) => t.mode === 2 && !!t.v2Pair && t.v2Pair !== ZERO,
      ) as Required<ClankerInput>[],
    [tokens],
  );

  const reads = useReadContracts({
    contracts: clankers.flatMap((c) => [
      { address: c.v2Pair, abi: V3_POOL_ABI, functionName: "slot0" as const },
      { address: c.v2Pair, abi: V3_POOL_ABI, functionName: "token0" as const },
      { address: c.v2Pair, abi: V3_POOL_ABI, functionName: "token1" as const },
    ]),
    query: { enabled: clankers.length > 0 },
  });

  return useMemo(() => {
    const out = new Map<string, bigint>();
    if (!reads.data) return out;
    const usdcLower = ADDRESSES.usdc.toLowerCase();
    for (let i = 0; i < clankers.length; i++) {
      const slot0 = reads.data[i * 3]?.result as readonly [bigint, ...unknown[]] | undefined;
      const t0 = reads.data[i * 3 + 1]?.result as Address | undefined;
      const t1 = reads.data[i * 3 + 2]?.result as Address | undefined;
      if (!slot0 || !t0 || !t1) continue;
      const clanker = clankers[i].address;
      const paired = t0.toLowerCase() === clanker.toLowerCase() ? t1 : t0;
      // USDC-paired only: FDV lands in USDC micros, directly comparable.
      if (paired.toLowerCase() !== usdcLower) continue;
      const sqrt = slot0[0];
      if (!sqrt) continue;
      out.set(clanker.toLowerCase(), computeFdv(sqrt, t0, clanker));
    }
    return out;
  }, [reads.data, clankers]);
}
