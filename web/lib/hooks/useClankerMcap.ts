"use client";

import { useMemo } from "react";
import { Address, erc20Abi } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { V3_POOL_ABI } from "@/lib/abis/v3";
import { ADDRESSES, LAUNCHPAD_TOKEN_DECIMALS, LAUNCHPAD_TOTAL_SUPPLY } from "@/lib/constants";

const Q192 = 2n ** 192n;
const TOTAL_SUPPLY_RAW = LAUNCHPAD_TOTAL_SUPPLY * 10n ** BigInt(LAUNCHPAD_TOKEN_DECIMALS);

/**
 * Implied FDV of a Clanker V3 token, in the paired token's raw units.
 * `sqrtPriceX96` from `pool.slot0()`; `token0` from `pool.token0()`.
 */
function computeClankerFdv(sqrtPriceX96: bigint, token0: Address, clankerToken: Address): bigint {
  const isClankerToken0 = token0.toLowerCase() === clankerToken.toLowerCase();
  const num = sqrtPriceX96 * sqrtPriceX96;
  // raw price = num / Q192 = token1-per-token0 (raw units, no decimal adjustment).
  if (isClankerToken0) {
    // 1 clanker raw → num/Q192 paired raw, so FDV (paired raw) = supply * num / Q192.
    return (TOTAL_SUPPLY_RAW * num) / Q192;
  }
  // 1 paired raw → num/Q192 clanker raw, so 1 clanker raw → Q192/num paired raw.
  return (TOTAL_SUPPLY_RAW * Q192) / num;
}

export interface ClankerMcap {
  /** "USDC" | "WETH" | "?" — the paired token's symbol. */
  pairedSymbol: "USDC" | "WETH" | "?";
  /** Paired token's decimals — read on-chain for non-USDC/non-WETH tokens. */
  pairedDecimals: number;
  /** FDV in paired-token raw units. */
  fdvRaw: bigint;
}

/**
 * Reads `pool.slot0/token0/token1` and computes the Clanker's implied FDV.
 * Returns `undefined` until the reads land.
 *
 * MATH-007: paired-token decimals are read on-chain via `erc20.decimals()`
 * for tokens that aren't USDC or WETH. The previous version hard-coded 18
 * for unrecognised pairs, which would mis-display mcap by 10^(18 -
 * actual_decimals) on any future non-standard paired token (eg a 6-dec
 * paired stablecoin or 8-dec wrapped BTC).
 */
export function useClankerMcap(token: Address | undefined, pool: Address | undefined): ClankerMcap | undefined {
  const reads = useReadContracts({
    contracts:
      pool && pool !== "0x0000000000000000000000000000000000000000"
        ? [
            { address: pool, abi: V3_POOL_ABI, functionName: "slot0" as const },
            { address: pool, abi: V3_POOL_ABI, functionName: "token0" as const },
            { address: pool, abi: V3_POOL_ABI, functionName: "token1" as const },
          ]
        : [],
    query: { enabled: !!pool && pool !== "0x0000000000000000000000000000000000000000" && !!token },
  });

  const t0 = reads.data?.[1]?.result as Address | undefined;
  const t1 = reads.data?.[2]?.result as Address | undefined;
  const paired = useMemo<Address | undefined>(() => {
    if (!t0 || !t1 || !token) return undefined;
    return t0.toLowerCase() === token.toLowerCase() ? t1 : t0;
  }, [t0, t1, token]);

  const usdcLower = ADDRESSES.usdc.toLowerCase();
  const wethLower = ADDRESSES.weth.toLowerCase();
  const isUsdc = paired ? paired.toLowerCase() === usdcLower : false;
  const isWeth = paired
    ? ADDRESSES.weth !== "0x0000000000000000000000000000000000000000" && paired.toLowerCase() === wethLower
    : false;
  const needsOnChainDecimals = !!paired && !isUsdc && !isWeth;

  // Read the paired token's decimals on-chain only when it's NOT one of the
  // two known fast paths. Cache forever (decimals never change).
  const pairedDecimalsQ = useReadContract({
    address: needsOnChainDecimals ? paired : undefined,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: needsOnChainDecimals, staleTime: Infinity, gcTime: Infinity },
  });

  return useMemo<ClankerMcap | undefined>(() => {
    if (!token || !pool || !reads.data) return undefined;
    const slot0 = reads.data[0]?.result as readonly [bigint, ...unknown[]] | undefined;
    if (!slot0 || !t0 || !t1 || !paired) return undefined;
    const sqrtPriceX96 = slot0[0];
    if (!sqrtPriceX96) return undefined;
    const pairedSymbol: ClankerMcap["pairedSymbol"] = isUsdc ? "USDC" : isWeth ? "WETH" : "?";
    // Decimals: 6 for USDC, 18 for WETH, on-chain read otherwise. While the
    // on-chain read is pending we return undefined so the caller doesn't
    // briefly format with a wrong divisor.
    let pairedDecimals: number;
    if (isUsdc) pairedDecimals = 6;
    else if (isWeth) pairedDecimals = 18;
    else {
      const d = pairedDecimalsQ.data;
      if (typeof d !== "number") return undefined;
      pairedDecimals = d;
    }
    const fdvRaw = computeClankerFdv(sqrtPriceX96, t0, token);
    return { pairedSymbol, pairedDecimals, fdvRaw };
  }, [token, pool, reads.data, t0, t1, paired, isUsdc, isWeth, pairedDecimalsQ.data]);
}
