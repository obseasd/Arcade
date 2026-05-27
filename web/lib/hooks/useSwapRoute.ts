"use client";

import { useMemo } from "react";
import { Address, zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { FACTORY_ABI } from "@/lib/abis/dex";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";

/**
 * Resolves the optimal V2 swap path between `tokenIn` and `tokenOut`:
 *   1. If one side is USDC → direct 2-hop path
 *   2. If a direct A↔B pool exists → direct
 *   3. Otherwise → 3-hop via USDC: [A, USDC, B]
 *
 * Multi-hop via USDC ALSO checks whether either side is a migrated launchpad
 * token. If so, `useLaunchpadRouter` is set so the caller routes the swap
 * through `Launchpad.swapMigratedRoute` instead of the V2 router - this
 * ensures the post-migration creator royalty is charged on each launchpad
 * leg (a plain V2 multi-hop would silently skip the royalty).
 */
export interface SwapRoute {
  path: Address[];
  hops: number; // 1 = direct, 2 = via USDC
  viaUsdc: boolean;
  /** True when the route must execute via `Launchpad.swapMigratedRoute` so
   * royalties on launchpad-migrated tokens are honoured. Only ever true when
   * `viaUsdc` is also true. */
  useLaunchpadRouter: boolean;
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

  // Only relevant when we already know we're going via USDC (multi-hop). We
  // check both tokens against the launchpad so we know whether to route the
  // swap through `swapMigratedRoute`. The `tokens(addr)` view returns a
  // zeroed tuple for non-launchpad tokens, so `migrated` is just `false`.
  const migrationProbe = useReadContracts({
    contracts: [
      {
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "tokens",
        args: tokenIn ? [tokenIn] : undefined,
      },
      {
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "tokens",
        args: tokenOut ? [tokenOut] : undefined,
      },
    ],
    query: {
      enabled:
        !!ADDRESSES.launchpad &&
        ADDRESSES.launchpad !== zeroAddress &&
        !!tokenIn &&
        !!tokenOut &&
        !isUsdcIn &&
        !isUsdcOut &&
        !sameToken,
    },
  });

  return useMemo<SwapRoute>(() => {
    if (!tokenIn || !tokenOut || sameToken) {
      return {
        path: [],
        hops: 0,
        viaUsdc: false,
        useLaunchpadRouter: false,
        isLoading: false,
      };
    }
    // Direct route - one side is USDC
    if (isUsdcIn || isUsdcOut) {
      return {
        path: [tokenIn, tokenOut],
        hops: 1,
        viaUsdc: false,
        useLaunchpadRouter: false,
        isLoading: false,
      };
    }
    const directPair = directPairQ.data as Address | undefined;
    const hasDirect = !!directPair && directPair !== zeroAddress;
    if (hasDirect) {
      return {
        path: [tokenIn, tokenOut],
        hops: 1,
        viaUsdc: false,
        useLaunchpadRouter: false,
        isLoading: false,
      };
    }
    // Multi-hop via USDC. Check whether either side is a migrated launchpad
    // token; if so, the swap must go through the launchpad router so the
    // royalty is paid on the relevant leg(s).
    const inState = migrationProbe.data?.[0];
    const outState = migrationProbe.data?.[1];
    // tokens(...) returns a tuple. `migrated` is the 8th field (index 7).
    const inMigrated =
      inState?.status === "success" && Array.isArray(inState.result) && !!(inState.result as readonly unknown[])[7];
    const outMigrated =
      outState?.status === "success" && Array.isArray(outState.result) && !!(outState.result as readonly unknown[])[7];
    return {
      path: [tokenIn, ADDRESSES.usdc, tokenOut],
      hops: 2,
      viaUsdc: true,
      useLaunchpadRouter: inMigrated || outMigrated,
      isLoading: directPairQ.isLoading || migrationProbe.isLoading,
    };
  }, [
    tokenIn,
    tokenOut,
    sameToken,
    isUsdcIn,
    isUsdcOut,
    directPairQ.data,
    directPairQ.isLoading,
    migrationProbe.data,
    migrationProbe.isLoading,
  ]);
}
