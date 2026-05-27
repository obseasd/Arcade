"use client";

import { Address, erc20Abi } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";

/**
 * Lists CLANKER_V3 launch tokens — those that launched directly into a locked
 * single-sided Uniswap V3 pool (mode == 2, migrated). These have NO V2 pair,
 * so they don't appear in useV2Tokens; the swap UI merges both lists and
 * routes V3 tokens through the V3 router/quoter.
 */
export interface V3TokenInfo {
  address: Address;
  symbol?: string;
  name?: string;
  decimals?: number;
  isV3: true;
}

const CLANKER_V3_MODE = 2;

export function useV3Tokens() {
  const countQ = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "getTokensCount",
    query: { enabled: !!ADDRESSES.launchpad },
  });
  const count = Number((countQ.data as bigint | undefined) ?? 0n);

  // All launchpad token addresses
  const addrCalls = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: ADDRESSES.launchpad,
      abi: LAUNCHPAD_ABI,
      functionName: "allTokens",
      args: [BigInt(i)],
    })),
    query: { enabled: count > 0 },
  });
  const addrs = (addrCalls.data ?? [])
    .map((c) => (c.status === "success" ? (c.result as unknown as Address) : undefined))
    .filter(Boolean) as Address[];

  // Each token's state (to read mode + migrated)
  const stateCalls = useReadContracts({
    contracts: addrs.map((a) => ({
      address: ADDRESSES.launchpad,
      abi: LAUNCHPAD_ABI,
      functionName: "tokens",
      args: [a],
    })),
    query: { enabled: addrs.length > 0 },
  });

  // tokens() returns a tuple; mode is index 4 (uint8), migrated is index 7 (bool).
  const v3Addrs: Address[] = [];
  if (stateCalls.data) {
    for (let i = 0; i < addrs.length; i++) {
      const r = stateCalls.data[i];
      if (r?.status !== "success") continue;
      const tuple = r.result as unknown as readonly unknown[];
      const mode = Number(tuple[4]);
      const migrated = Boolean(tuple[7]);
      if (mode === CLANKER_V3_MODE && migrated) v3Addrs.push(addrs[i]);
    }
  }

  // Metadata for the V3 tokens
  const metaCalls = useReadContracts({
    contracts: v3Addrs.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "symbol" },
      { address: t, abi: erc20Abi, functionName: "name" },
      { address: t, abi: erc20Abi, functionName: "decimals" },
    ]),
    query: { enabled: v3Addrs.length > 0 },
  });

  const tokens: V3TokenInfo[] = v3Addrs.map((address, i) => ({
    address,
    symbol: metaCalls.data?.[3 * i]?.result as string | undefined,
    name: metaCalls.data?.[3 * i + 1]?.result as string | undefined,
    decimals: metaCalls.data?.[3 * i + 2]?.result as number | undefined,
    isV3: true as const,
  }));

  // Set of lowercased V3 addresses for quick membership checks.
  const v3Set = new Set(v3Addrs.map((a) => a.toLowerCase()));

  return {
    isLoading:
      countQ.isLoading || addrCalls.isLoading || stateCalls.isLoading || metaCalls.isLoading,
    tokens,
    isV3Token: (addr?: Address) => !!addr && v3Set.has(addr.toLowerCase()),
  };
}
