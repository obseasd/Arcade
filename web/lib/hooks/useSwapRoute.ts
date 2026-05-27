"use client";

import { useMemo } from "react";
import { Address, zeroAddress } from "viem";
import { useReadContract } from "wagmi";
import { FACTORY_ABI } from "@/lib/abis/dex";
import { ADDRESSES } from "@/lib/constants";

/**
 * Resolves the optimal V2 swap path between `tokenIn` and `tokenOut`:
 *   1. If one side is USDC → direct 2-hop path
 *   2. If a direct A↔B pool exists → direct
 *   3. Otherwise → 3-hop via USDC: [A, USDC, B]
 *
 * This matches Hyperswap/Uniswap V2 behaviour where USDC acts as the universal
 * routing token. We assume every launchpad token has a USDC pool after
 * migration, so the via-USDC fallback is almost always valid.
 */
export interface SwapRoute {
  path: Address[];
  hops: number; // 1 = direct, 2 = via USDC
  viaUsdc: boolean;
  isLoading: boolean;
}

export function useSwapRoute(tokenIn?: Address, tokenOut?: Address): SwapRoute {
  const isUsdcIn = tokenIn?.toLowerCase() === ADDRESSES.usdc.toLowerCase();
  const isUsdcOut = tokenOut?.toLowerCase() === ADDRESSES.usdc.toLowerCase();
  const sameToken =
    !!tokenIn && !!tokenOut && tokenIn.toLowerCase() === tokenOut.toLowerCase();

  // Look up the direct pair (only meaningful when neither side is USDC).
  const directPairQ = useReadContract({
    address: ADDRESSES.factory,
    abi: FACTORY_ABI,
    functionName: "getPair",
    args: tokenIn && tokenOut ? [tokenIn, tokenOut] : undefined,
    query: { enabled: !!tokenIn && !!tokenOut && !isUsdcIn && !isUsdcOut && !sameToken },
  });

  return useMemo<SwapRoute>(() => {
    if (!tokenIn || !tokenOut || sameToken) {
      return { path: [], hops: 0, viaUsdc: false, isLoading: false };
    }
    // Direct route — one side is USDC
    if (isUsdcIn || isUsdcOut) {
      return { path: [tokenIn, tokenOut], hops: 1, viaUsdc: false, isLoading: false };
    }
    const directPair = directPairQ.data as Address | undefined;
    const hasDirect = !!directPair && directPair !== zeroAddress;
    if (hasDirect) {
      return { path: [tokenIn, tokenOut], hops: 1, viaUsdc: false, isLoading: false };
    }
    // Multi-hop via USDC
    return {
      path: [tokenIn, ADDRESSES.usdc, tokenOut],
      hops: 2,
      viaUsdc: true,
      isLoading: directPairQ.isLoading,
    };
  }, [tokenIn, tokenOut, sameToken, isUsdcIn, isUsdcOut, directPairQ.data, directPairQ.isLoading]);
}
