"use client";

import { useMemo } from "react";
import { Address, encodePacked, keccak256 } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { V3_LOCKER_ABI, V3_POOL_ABI } from "@/lib/abis/v3";
import { ADDRESSES } from "@/lib/constants";

const Q128 = 1n << 128n;

interface PositionInfo {
  pool: Address;
  token0: Address;
  token1: Address;
  clankerToken: Address;
  pairedToken: Address;
  numRanges: number;
  tickLowers: readonly [number, number, number];
  tickUppers: readonly [number, number, number];
  exists: boolean;
}

/**
 * Standard Uniswap V3 fee growth math for a single range:
 *   feeGrowthInside = feeGrowthGlobal - feeGrowthBelow(tickLower) - feeGrowthAbove(tickUpper)
 * where the "below/above" terms depend on where the current tick sits relative
 * to the lower/upper ticks (see Uniswap V3 Tick.getFeeGrowthInside).
 */
function feeGrowthInside(
  feeGrowthGlobal: bigint,
  feeGrowthOutsideLower: bigint,
  feeGrowthOutsideUpper: bigint,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
): bigint {
  // 256-bit wraparound subtraction (Uniswap V3 stores fee growth as a circular counter).
  const sub = (a: bigint, b: bigint) => (a - b) & ((1n << 256n) - 1n);

  const below =
    tickCurrent >= tickLower
      ? feeGrowthOutsideLower
      : sub(feeGrowthGlobal, feeGrowthOutsideLower);
  const above =
    tickCurrent < tickUpper
      ? feeGrowthOutsideUpper
      : sub(feeGrowthGlobal, feeGrowthOutsideUpper);
  return sub(sub(feeGrowthGlobal, below), above);
}

export interface ClaimablePreview {
  /** Pending paired-token amount (USDC or WETH raw units) across all ranges. */
  pairedRaw: bigint;
  /** Pending clanker-token amount (18-dec raw units) across all ranges. */
  clankerRaw: bigint;
  /** True while reads are pending. */
  isLoading: boolean;
}

/**
 * Computes claimable LP fees for a Clanker token's locked position by reading
 * the V3 pool state directly. Sums tokensOwed + uncrystallized fee growth across
 * all 1-3 ranges.
 *
 * Returns the *position-wide* pending amounts. To get a specific recipient's
 * share, multiply by their bps / 10000.
 */
export function useClankerClaimable(token: Address | undefined): ClaimablePreview {
  // 1) positionId for this token
  const posIdQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "positionIdByToken",
    args: token ? [token] : undefined,
    query: { enabled: !!token && ADDRESSES.v3Locker !== "0x0000000000000000000000000000000000000000" },
  });
  const positionId = (posIdQ.data as bigint | undefined) ?? 0n;

  // 2) Position details (pool, tick ranges)
  const posQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "getPosition",
    args: positionId > 0n ? [positionId] : undefined,
    query: { enabled: positionId > 0n },
  });
  const pos = posQ.data as PositionInfo | undefined;
  const pool = pos?.pool;
  const numRanges = pos?.numRanges ?? 0;
  const lowers = pos?.tickLowers ?? ([0, 0, 0] as const);
  const uppers = pos?.tickUppers ?? ([0, 0, 0] as const);

  // 3) Pool globals + tick info + position info for each range, batched.
  // For each range we need: pool.positions(positionKey), pool.ticks(lower), pool.ticks(upper).
  // Plus once: pool.slot0(), pool.feeGrowthGlobal0X128(), pool.feeGrowthGlobal1X128().
  const calls = useMemo(() => {
    if (!pool || numRanges === 0) return [];
    const c: any[] = [
      { address: pool, abi: V3_POOL_ABI, functionName: "slot0" as const },
      { address: pool, abi: V3_POOL_ABI, functionName: "feeGrowthGlobal0X128" as const },
      { address: pool, abi: V3_POOL_ABI, functionName: "feeGrowthGlobal1X128" as const },
    ];
    for (let i = 0; i < numRanges; i++) {
      const tl = lowers[i];
      const tu = uppers[i];
      const key = keccak256(
        encodePacked(["address", "int24", "int24"], [ADDRESSES.v3Locker, tl, tu]),
      );
      c.push({ address: pool, abi: V3_POOL_ABI, functionName: "positions" as const, args: [key] });
      c.push({ address: pool, abi: V3_POOL_ABI, functionName: "ticks" as const, args: [tl] });
      c.push({ address: pool, abi: V3_POOL_ABI, functionName: "ticks" as const, args: [tu] });
    }
    return c;
  }, [pool, numRanges, lowers, uppers]);

  const reads = useReadContracts({
    contracts: calls,
    query: { enabled: calls.length > 0 },
  });

  return useMemo<ClaimablePreview>(() => {
    if (!pool || numRanges === 0 || !reads.data || !pos) {
      return { pairedRaw: 0n, clankerRaw: 0n, isLoading: posIdQ.isLoading || posQ.isLoading || reads.isLoading };
    }
    const slot0 = reads.data[0]?.result as readonly [bigint, number, ...unknown[]] | undefined;
    const fg0 = reads.data[1]?.result as bigint | undefined;
    const fg1 = reads.data[2]?.result as bigint | undefined;
    if (!slot0 || fg0 === undefined || fg1 === undefined) {
      return { pairedRaw: 0n, clankerRaw: 0n, isLoading: false };
    }
    const tickCurrent = Number(slot0[1]);
    let pending0 = 0n;
    let pending1 = 0n;
    for (let i = 0; i < numRanges; i++) {
      const base = 3 + i * 3;
      const posInfo = reads.data[base]?.result as
        | readonly [bigint, bigint, bigint, bigint, bigint]
        | undefined;
      const tickLowerInfo = reads.data[base + 1]?.result as
        | readonly [bigint, bigint, bigint, bigint, ...unknown[]]
        | undefined;
      const tickUpperInfo = reads.data[base + 2]?.result as
        | readonly [bigint, bigint, bigint, bigint, ...unknown[]]
        | undefined;
      if (!posInfo || !tickLowerInfo || !tickUpperInfo) continue;
      const [liquidity, fgi0Last, fgi1Last, owed0, owed1] = posInfo;
      const fgo0Lower = tickLowerInfo[2];
      const fgo1Lower = tickLowerInfo[3];
      const fgo0Upper = tickUpperInfo[2];
      const fgo1Upper = tickUpperInfo[3];
      const tl = lowers[i];
      const tu = uppers[i];
      const fgi0 = feeGrowthInside(fg0, fgo0Lower, fgo0Upper, tl, tu, tickCurrent);
      const fgi1 = feeGrowthInside(fg1, fgo1Lower, fgo1Upper, tl, tu, tickCurrent);
      const sub = (a: bigint, b: bigint) => (a - b) & ((1n << 256n) - 1n);
      const delta0 = sub(fgi0, fgi0Last);
      const delta1 = sub(fgi1, fgi1Last);
      const uncrystallized0 = (delta0 * liquidity) / Q128;
      const uncrystallized1 = (delta1 * liquidity) / Q128;
      pending0 += owed0 + uncrystallized0;
      pending1 += owed1 + uncrystallized1;
    }
    // Map (token0, token1) → (paired, clanker)
    const clankerIsToken0 = pos.token0.toLowerCase() === pos.clankerToken.toLowerCase();
    const pairedRaw = clankerIsToken0 ? pending1 : pending0;
    const clankerRaw = clankerIsToken0 ? pending0 : pending1;
    return { pairedRaw, clankerRaw, isLoading: false };
  }, [pool, numRanges, lowers, pos, reads.data, posIdQ.isLoading, posQ.isLoading, reads.isLoading]);
}
