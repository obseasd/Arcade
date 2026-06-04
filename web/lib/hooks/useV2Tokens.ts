"use client";

import { Address, erc20Abi } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { FACTORY_ABI, PAIR_ABI } from "@/lib/abis/dex";
import { ADDRESSES } from "@/lib/constants";

/**
 * Lists all tokens that have a USDC-quoted V2 pair (post-migration launchpad
 * tokens + manually created USDC pools).
 *
 * Returns each token's address, name, symbol and decimals.
 */
export function useV2Tokens() {
  const pairsLengthQ = useReadContract({
    address: ADDRESSES.factory,
    abi: FACTORY_ABI,
    functionName: "allPairsLength",
    query: { enabled: !!ADDRESSES.factory },
  });

  const pairsLength = (pairsLengthQ.data as bigint | undefined) ?? 0n;

  // Read pair addresses
  const pairAddrCalls = useReadContracts({
    contracts: Array.from({ length: Number(pairsLength) }, (_, i) => ({
      address: ADDRESSES.factory,
      abi: FACTORY_ABI,
      functionName: "allPairs",
      args: [BigInt(i)],
    })),
    query: { enabled: pairsLength > 0n },
  });

  const pairs = (pairAddrCalls.data ?? [])
    .map((c) => (c.status === "success" ? (c.result as unknown as Address) : undefined))
    .filter(Boolean) as Address[];

  // Read token0 + token1 for each pair (to identify the non-USDC side)
  const tokenCalls = useReadContracts({
    contracts: pairs.flatMap((p) => [
      { address: p, abi: PAIR_ABI, functionName: "token0" },
      { address: p, abi: PAIR_ABI, functionName: "token1" },
    ]),
    query: { enabled: pairs.length > 0 },
  });

  const tokenAddresses = new Set<Address>();
  if (tokenCalls.data) {
    for (let i = 0; i < pairs.length; i++) {
      const t0 = tokenCalls.data[2 * i]?.result as Address | undefined;
      const t1 = tokenCalls.data[2 * i + 1]?.result as Address | undefined;
      if (t0 && t1) {
        if (t0.toLowerCase() !== ADDRESSES.usdc.toLowerCase()) tokenAddresses.add(t0);
        if (t1.toLowerCase() !== ADDRESSES.usdc.toLowerCase()) tokenAddresses.add(t1);
      }
    }
  }
  const tokenList = Array.from(tokenAddresses);

  // Read metadata for each token
  const metaCalls = useReadContracts({
    contracts: tokenList.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "symbol" },
      { address: t, abi: erc20Abi, functionName: "name" },
      { address: t, abi: erc20Abi, functionName: "decimals" },
    ]),
    query: { enabled: tokenList.length > 0 },
  });

  // Fall back to a short address tag + 18 decimals when the multicall
  // returns a partial payload. arcTestnet has no Multicall3, so the V3
  // periphery `useReadContracts` path occasionally drops one of the three
  // reads (symbol/name/decimals). Sane defaults keep the swap/select UIs
  // from rendering `?` icons for pairs that DO exist on-chain.
  const tokens = tokenList.map((address, i) => {
    const sym = metaCalls.data?.[3 * i]?.result as string | undefined;
    const nm = metaCalls.data?.[3 * i + 1]?.result as string | undefined;
    const dec = metaCalls.data?.[3 * i + 2]?.result as number | undefined;
    return {
      address,
      symbol: sym && sym.length > 0 ? sym : `${address.slice(0, 6)}…${address.slice(-4)}`,
      name: nm,
      decimals: dec ?? 18,
    };
  });

  return {
    isLoading: pairsLengthQ.isLoading || pairAddrCalls.isLoading || tokenCalls.isLoading || metaCalls.isLoading,
    pairs,
    tokens,
  };
}
