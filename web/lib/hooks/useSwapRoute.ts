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
 * token. If so, `useLaunchpadRouter` is set so the caller routes the token<->
 * token swap through `ArcadeMigratedRouter.swapMigratedRoute` (extracted from
 * the launchpad for EIP-170) instead of the plain V2 router. This is NOT about
 * a royalty any more -- the graduated pair charges the fee in its own K on
 * every route -- it is about the usdcMidMin MID-LEG SANDWICH GUARD: the plain
 * V2 3-hop checks only the final minOut, so token<->token migrated MUST go
 * through the router that enforces the intermediate floor.
 */
export interface SwapRoute {
  path: Address[];
  hops: number; // 1 = direct, 2 = via USDC
  viaUsdc: boolean;
  /** True when the token<->token route must execute via
   * `ArcadeMigratedRouter.swapMigratedRoute` for its mid-leg sandwich guard.
   * Only ever true when `viaUsdc` is also true. (Name kept for churn reasons;
   * it targets the migrated ROUTER, not the launchpad.) */
  useLaunchpadRouter: boolean;
  /** Whether the input token is a curve-migrated launchpad token. Used by the
   *  swap card to compute the displayed fee (the pair's in-K 0.30%). */
  inMigrated: boolean;
  /** Whether the output token is curve-migrated (royalty on leg 2). */
  outMigrated: boolean;
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
        functionName: "getTokenState",
        args: tokenIn ? [tokenIn] : undefined,
      },
      {
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "getTokenState",
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
        inMigrated: false,
        outMigrated: false,
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
        inMigrated: false,
        outMigrated: false,
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
        inMigrated: false,
        outMigrated: false,
        isLoading: false,
      };
    }
    // Multi-hop via USDC. Check whether either side is a migrated launchpad
    // token; if so, the swap must go through the launchpad router so the
    // royalty is paid on the relevant leg(s).
    const inState = migrationProbe.data?.[0];
    const outState = migrationProbe.data?.[1];
    // getTokenState(...) returns a named struct (zeroed for non-launchpad
    // tokens, so `migrated` is just false). Replaced the removed `tokens`
    // getter (dropped for EIP-170).
    const inMigrated =
      inState?.status === "success" && !!(inState.result as { migrated?: boolean } | undefined)?.migrated;
    const outMigrated =
      outState?.status === "success" && !!(outState.result as { migrated?: boolean } | undefined)?.migrated;
    return {
      path: [tokenIn, ADDRESSES.usdc, tokenOut],
      hops: 2,
      viaUsdc: true,
      useLaunchpadRouter: inMigrated || outMigrated,
      inMigrated,
      outMigrated,
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
