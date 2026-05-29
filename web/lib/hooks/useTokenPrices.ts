"use client";

import { useMemo } from "react";
import { Address } from "viem";
import { useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";

const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a".toLowerCase();

/**
 * Best-effort live USD prices for a list of tokens, used in the token-select
 * dropdown. Returns a map keyed by lowercased address → price string ($X.YZ).
 *
 * Strategy:
 *   - USDC: $1.00
 *   - EURC: ~$1.08 (a placeholder constant; replace with a feed when needed)
 *   - Anything else: read launchpad.marketCap(token) / 1B supply for an
 *     implied price. Returns undefined for tokens not on the launchpad.
 */
export function useTokenPrices(tokens: { address: Address }[]): Map<string, string> {
  const launchpadTokens = useMemo(
    () =>
      tokens.filter(
        (t) =>
          t.address.toLowerCase() !== ADDRESSES.usdc.toLowerCase() &&
          t.address.toLowerCase() !== EURC_ADDRESS,
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

  return useMemo(() => {
    const out = new Map<string, string>();
    out.set(ADDRESSES.usdc.toLowerCase(), "$1.00");
    out.set(EURC_ADDRESS, "$1.08");

    if (mcapCalls.data) {
      for (let i = 0; i < launchpadTokens.length; i++) {
        const r = mcapCalls.data[i];
        if (r?.status !== "success") continue;
        const mcapRaw = r.result as bigint;
        if (mcapRaw === 0n) continue;
        // marketCap is in USDC 6-dec raw, total supply is 1B tokens (18 dec).
        // price (USD per token) = marketCap / 1B
        const mcapUsd = Number(mcapRaw) / 1e6;
        const price = mcapUsd / 1_000_000_000;
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
  }, [mcapCalls.data, launchpadTokens]);
}
