"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, erc20Abi } from "viem";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";
import { TOKEN_CREATED_EVT } from "@/lib/eventSignatures";
import { CHUNK_SMALL, MAX_BACK_BLOCKS, scanLogsChunked } from "@/lib/eventScan";
import { useWatchEvent } from "./useWatchEvent";

export interface LaunchpadTokenInfo {
  address: Address;
  creator: Address;
  createdAt: bigint;
  migratedAt: bigint;
  migrated: boolean;
  /** 0 = PUMP, 1 = CLANKER (curve), 2 = CLANKER_V3 (locked single-sided). */
  mode: number;
  realUsdcReserve: bigint;
  tokensSold: bigint;
  v2Pair: Address;
  metadataURI: string;
  name?: string;
  symbol?: string;
  marketCap?: bigint;
}

export function useLaunchpadTokens(): { tokens: LaunchpadTokenInfo[]; isLoading: boolean } {
  const publicClient = usePublicClient();
  const countQ = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "getTokensCount",
    query: { enabled: !!ADDRESSES.launchpad },
  });
  const count = Number((countQ.data as bigint | undefined) ?? 0n);

  // Live: any TokenCreated event triggers a refetch so the list grows without
  // a manual refresh.
  const refetchAll = useCallback(() => {
    countQ.refetch();
  }, [countQ]);
  useWatchEvent({
    address: ADDRESSES.launchpad,
    event: TOKEN_CREATED_EVT,
    onLogs: refetchAll,
  });

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

  const stateCalls = useReadContracts({
    contracts: addresses.flatMap((addr) => [
      { address: ADDRESSES.launchpad, abi: LAUNCHPAD_ABI, functionName: "getTokenState", args: [addr] },
      { address: ADDRESSES.launchpad, abi: LAUNCHPAD_ABI, functionName: "marketCap", args: [addr] },
      { address: addr, abi: erc20Abi, functionName: "name" },
      { address: addr, abi: erc20Abi, functionName: "symbol" },
    ]),
    query: { enabled: addresses.length > 0 },
  });

  // Batch-fetch all TokenCreated events once; build a single address → metadataURI
  // map. metadataURI is no longer stored in state; it lives in the event only.
  const [metadataMap, setMetadataMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!publicClient || addresses.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logs = await scanLogsChunked<any>(
          publicClient,
          { address: ADDRESSES.launchpad, event: TOKEN_CREATED_EVT },
          latest,
          { chunk: CHUNK_SMALL, maxBack: MAX_BACK_BLOCKS, label: "lp.TokenCreated" },
        );
        const map = new Map<string, string>();
        for (const log of logs) {
          const tokenAddr = (log.args.token as string).toLowerCase();
          const uri = (log.args.metadataURI as string) ?? "";
          if (!map.has(tokenAddr)) map.set(tokenAddr, uri);
        }
        if (!cancelled) setMetadataMap(map);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, addresses.length]);

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
        mode: Number(state?.mode ?? 0),
        realUsdcReserve: state?.realUsdcReserve ?? 0n,
        tokensSold: state?.tokensSold ?? 0n,
        v2Pair: state?.v2Pair ?? ("0x0" as Address),
        metadataURI: metadataMap.get(addr.toLowerCase()) ?? "",
        marketCap: mcap,
        name,
        symbol,
      };
    });
  }, [addresses, stateCalls.data, metadataMap]);

  return {
    tokens,
    isLoading: countQ.isLoading || addrCalls.isLoading || stateCalls.isLoading,
  };
}
