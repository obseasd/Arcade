"use client";

import { useMemo } from "react";
import { Address } from "viem";
import { useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";

/**
 * Best-effort live USD prices for a list of tokens, used in the token-select
 * dropdown. Returns a map keyed by lowercased address -> price string ($X.YZ).
 *
 * Strategy:
 *   - USDC: $1.00
 *   - Anything else: read launchpad.marketCap(token) / 1B supply for an
 *     implied price. Returns undefined for tokens not on the launchpad.
 *
 * EURC used to be hardcoded at $1.08 here. The audit (2026-06-06) flagged
 * that as a fake price surfaced in the swap picker; removed until a real
 * EUR/USD feed lands.
 */
export function useTokenPrices(tokens: { address: Address }[]): Map<string, string> {
  const launchpadTokens = useMemo(
    () =>
      tokens.filter(
        (t) => t.address.toLowerCase() !== ADDRESSES.usdc.toLowerCase(),
      ),
    [tokens],
  );

  const mcapCalls = useReadContracts({
    contracts: launchpadTokens.map((t) => ({
      address: ADDRESSES.launchpad,
      abi: LAUNCHPAD_ABI,
      functionName: "marketCap" as const,
      args: [t.address] as const,
    })),
    query: { enabled: launchpadTokens.length > 0 },
  });

  // marketCap() prices circulating supply, so the price denominator must be
  // circulating too. Hardcoding 1B here read ~6.4% low on every migrated token
  // (they burn ~60M to DEAD at graduation) and drifted further with any holder
  // burn. Fetched in a parallel multicall rather than assumed.
  const supplyCalls = useReadContracts({
    contracts: launchpadTokens.map((t) => ({
      address: ADDRESSES.launchpad,
      abi: LAUNCHPAD_ABI,
      functionName: "circulatingSupply" as const,
      args: [t.address] as const,
    })),
    query: { enabled: launchpadTokens.length > 0 },
  });

  return useMemo(() => {
    const out = new Map<string, string>();
    out.set(ADDRESSES.usdc.toLowerCase(), "$1.00");

    if (mcapCalls.data) {
      for (let i = 0; i < launchpadTokens.length; i++) {
        const r = mcapCalls.data[i];
        if (r?.status !== "success") continue;
        const mcapRaw = r.result as bigint;
        if (mcapRaw === 0n) continue;
        // price (USD per token) = marketCap / circulatingSupply. Both come from
        // the launchpad so they can never disagree about the denominator.
        const supplyRes = supplyCalls.data?.[i];
        if (supplyRes?.status !== "success") continue;
        const circulating = supplyRes.result as bigint;
        if (circulating === 0n) continue;
        const mcapUsd = Number(mcapRaw) / 1e6;
        const price = mcapUsd / (Number(circulating) / 1e18);
        if (price <= 0 || !isFinite(price)) continue;
        const formatted =
          price < 0.000001
            ? `$${price.toExponential(2)}`
            : price < 1
              ? `$${price.toFixed(6)}`
              : `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
        out.set(launchpadTokens[i].address.toLowerCase(), formatted);
      }
    }
    return out;
  }, [mcapCalls.data, supplyCalls.data, launchpadTokens]);
}
