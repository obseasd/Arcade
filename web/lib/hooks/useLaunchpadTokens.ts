"use client";

import { useMemo } from "react";
import { Address, erc20Abi } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";

export interface LaunchpadTokenInfo {
  address: Address;
  creator: Address;
  createdAt: bigint;
  migratedAt: bigint;
  migrated: boolean;
  realUsdcReserve: bigint;
  tokensSold: bigint;
  v2Pair: Address;
  metadataURI: string;
  name?: string;
  symbol?: string;
  marketCap?: bigint;
}

export function useLaunchpadTokens(): { tokens: LaunchpadTokenInfo[]; isLoading: boolean } {
  const countQ = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "getTokensCount",
    query: { enabled: !!ADDRESSES.launchpad },
  });
  const count = Number((countQ.data as bigint | undefined) ?? 0n);

  // Read all token addresses
  const addrCalls = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: ADDRESSES.launchpad,
      abi: LAUNCHPAD_ABI,
      functionName: "allTokens",
      args: [BigInt(i)],
    })),
    query: { enabled: count > 0 },
  });

  const addresses = useMemo(
    () =>
      (addrCalls.data ?? [])
        .map((r) => (r.status === "success" ? (r.result as unknown as Address) : undefined))
        .filter(Boolean) as Address[],
    [addrCalls.data],
  );

  // Read token state + name/symbol + mcap for each address
  const stateCalls = useReadContracts({
    contracts: addresses.flatMap((addr) => [
      { address: ADDRESSES.launchpad, abi: LAUNCHPAD_ABI, functionName: "getTokenState", args: [addr] },
      { address: ADDRESSES.launchpad, abi: LAUNCHPAD_ABI, functionName: "marketCap", args: [addr] },
      { address: addr, abi: erc20Abi, functionName: "name" },
      { address: addr, abi: erc20Abi, functionName: "symbol" },
    ]),
    query: { enabled: addresses.length > 0 },
  });

  const tokens: LaunchpadTokenInfo[] = useMemo(() => {
    if (!stateCalls.data) return [];
    return addresses.map((addr, i) => {
      const state = stateCalls.data[4 * i]?.result as any;
      const mcap = stateCalls.data[4 * i + 1]?.result as bigint | undefined;
      const name = stateCalls.data[4 * i + 2]?.result as string | undefined;
      const symbol = stateCalls.data[4 * i + 3]?.result as string | undefined;
      return {
        address: addr,
        creator: state?.creator ?? ("0x0" as Address),
        createdAt: state?.createdAt ?? 0n,
        migratedAt: state?.migratedAt ?? 0n,
        migrated: !!state?.migrated,
        realUsdcReserve: state?.realUsdcReserve ?? 0n,
        tokensSold: state?.tokensSold ?? 0n,
        v2Pair: state?.v2Pair ?? ("0x0" as Address),
        metadataURI: state?.metadataURI ?? "",
        marketCap: mcap,
        name,
        symbol,
      };
    });
  }, [addresses, stateCalls.data]);

  return {
    tokens,
    isLoading: countQ.isLoading || addrCalls.isLoading || stateCalls.isLoading,
  };
}
