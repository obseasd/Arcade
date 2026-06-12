"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, erc20Abi } from "viem";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";
import { TOKEN_CREATED_EVT } from "@/lib/eventSignatures";
import { CHUNK_SMALL, MAX_BACK_BLOCKS, scanLogsChunked } from "@/lib/eventScan";
import { getLaunchpadGenerations } from "@/lib/launchpadGenerations";
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
  /** Launchpad generation this token was created on. The live launchpad
   *  has the highest number; prior generations decrement from there.
   *  Defaults to the current generation when the field is omitted by a
   *  legacy consumer that hasn't been updated. */
  generation?: number;
  /** Address of the launchpad contract that originally minted this
   *  token. Equals ADDRESSES.launchpad for current-gen tokens; older
   *  entries point at the prior-generation contract addresses kept in
   *  lib/launchpadGenerations.ts. Use this when writing follow-up
   *  reads (state, marketCap) so they hit the correct authority. */
  launchpad?: Address;
  /** True when this token was minted by a non-current launchpad. UIs
   *  use the flag to render a "legacy" badge and disable interactive
   *  trade actions that depend on the live launchpad's state. */
  legacy?: boolean;
}

/**
 * Reads every token minted across every launchpad generation. The live
 * launchpad's writes still target ADDRESSES.launchpad, but reads now
 * include all prior generations from lib/launchpadGenerations.ts so the
 * /my-tokens portfolio and the launchpad explorer keep showing pre-redeploy
 * tokens.
 *
 * Per generation we:
 *   1. Call getTokensCount on its launchpad.
 *   2. Call allTokens(i) for each index to fetch the token addresses.
 *   3. Batch a 4-call read per token (getTokenState + marketCap + ERC20
 *      name + ERC20 symbol) so we render the full card without an extra
 *      RPC roundtrip.
 * The reads are independent across generations so we surface failures
 * per-generation (a generation whose RPC failed is skipped, not
 * propagated to the whole hook). The live-event subscription still
 * watches only the current launchpad — prior generations don't emit
 * anymore.
 */
export function useLaunchpadTokens(): { tokens: LaunchpadTokenInfo[]; isLoading: boolean } {
  const publicClient = usePublicClient();
  const generations = useMemo(() => getLaunchpadGenerations(), []);

  // -------- Per-generation token counts --------
  // useReadContracts batches the count call across every generation in
  // ONE multicall, so even a 5-generation history adds zero RPC
  // roundtrips vs the single-generation version.
  const countQueries = useReadContracts({
    contracts: generations.map((g) => ({
      address: g.address,
      abi: LAUNCHPAD_ABI,
      functionName: "getTokensCount",
    })),
    query: { enabled: generations.length > 0 },
  });

  const refetchAll = useCallback(() => {
    void countQueries.refetch();
  }, [countQueries]);
  useWatchEvent({
    address: ADDRESSES.launchpad,
    event: TOKEN_CREATED_EVT,
    onLogs: refetchAll,
  });

  // Per-generation tuple of (generation, count). We carry the generation
  // metadata alongside the count so downstream maps can tag each token
  // with its origin without zipping back to the generations array.
  const perGenCounts = useMemo(() => {
    if (!countQueries.data) return [];
    return generations.map((g, i) => ({
      gen: g,
      count: Number((countQueries.data?.[i]?.result as bigint | undefined) ?? 0n),
    }));
  }, [generations, countQueries.data]);

  // -------- Per-generation address lists --------
  // Flatten every (generation, index) pair into a single multicall so
  // /my-tokens issues just one RPC roundtrip for the address fetch
  // regardless of the number of generations.
  const addrCallSpecs = useMemo(() => {
    const out: { gen: number; launchpad: Address; idx: number }[] = [];
    for (const { gen, count } of perGenCounts) {
      for (let i = 0; i < count; i++) {
        out.push({ gen: gen.generation, launchpad: gen.address, idx: i });
      }
    }
    return out;
  }, [perGenCounts]);

  const addrCalls = useReadContracts({
    contracts: addrCallSpecs.map((s) => ({
      address: s.launchpad,
      abi: LAUNCHPAD_ABI,
      functionName: "allTokens",
      args: [BigInt(s.idx)],
    })),
    query: { enabled: addrCallSpecs.length > 0 },
  });

  // Pair each resolved address with its source generation so the
  // metadata propagates through to the final LaunchpadTokenInfo.
  const addressEntries = useMemo(() => {
    if (!addrCalls.data) return [];
    return addrCallSpecs.flatMap((spec, i) => {
      const r = addrCalls.data?.[i];
      if (!r || r.status !== "success") return [];
      return [
        {
          address: r.result as unknown as Address,
          generation: spec.gen,
          launchpad: spec.launchpad,
        },
      ];
    });
  }, [addrCallSpecs, addrCalls.data]);

  const addresses = useMemo(() => addressEntries.map((e) => e.address), [addressEntries]);

  const stateCalls = useReadContracts({
    contracts: addressEntries.flatMap((entry) => [
      // Each token's state + marketCap lives on the launchpad that
      // minted it, NOT on the current launchpad. Using entry.launchpad
      // is what lets prior-generation tokens still surface a valid
      // realUsdcReserve / migrated / mode triple in the portfolio.
      { address: entry.launchpad, abi: LAUNCHPAD_ABI, functionName: "getTokenState", args: [entry.address] },
      { address: entry.launchpad, abi: LAUNCHPAD_ABI, functionName: "marketCap", args: [entry.address] },
      { address: entry.address, abi: erc20Abi, functionName: "name" },
      { address: entry.address, abi: erc20Abi, functionName: "symbol" },
    ]),
    query: { enabled: addressEntries.length > 0 },
  });

  // Batch-fetch all TokenCreated events ACROSS every generation. Each
  // generation gets its own scanLogsChunked pass and the resulting
  // address → metadataURI map is merged — first-write wins so the
  // newer-generation entry (scanned first) overrides any duplicate from
  // an older one with a stale URI.
  const [metadataMap, setMetadataMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!publicClient || addresses.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const perGenLogs = await Promise.all(
          generations.map(async (g) => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return await scanLogsChunked<any>(
                publicClient,
                { address: g.address, event: TOKEN_CREATED_EVT },
                latest,
                { chunk: CHUNK_SMALL, maxBack: MAX_BACK_BLOCKS, label: `lp.TokenCreated.gen${g.generation}` },
              );
            } catch {
              return [];
            }
          }),
        );
        const map = new Map<string, string>();
        for (const logs of perGenLogs) {
          for (const log of logs) {
            const tokenAddr = (log.args.token as string).toLowerCase();
            const uri = (log.args.metadataURI as string) ?? "";
            // first-write wins so the newer generation overrides any
            // duplicate metadataURI from an older one (the metadata is
            // immutable on chain but the URI history might differ).
            if (!map.has(tokenAddr)) map.set(tokenAddr, uri);
          }
        }
        if (!cancelled) setMetadataMap(map);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, addresses.length, generations]);

  const currentGen = generations.find((g) => g.isCurrent)?.generation;

  const tokens: LaunchpadTokenInfo[] = useMemo(() => {
    if (!stateCalls.data) return [];
    return addressEntries.map((entry, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = stateCalls.data[4 * i]?.result as any;
      const mcap = stateCalls.data[4 * i + 1]?.result as bigint | undefined;
      const name = stateCalls.data[4 * i + 2]?.result as string | undefined;
      const symbol = stateCalls.data[4 * i + 3]?.result as string | undefined;
      return {
        address: entry.address,
        creator: state?.creator ?? ("0x0" as Address),
        createdAt: state?.createdAt ?? 0n,
        migratedAt: state?.migratedAt ?? 0n,
        migrated: !!state?.migrated,
        mode: Number(state?.mode ?? 0),
        realUsdcReserve: state?.realUsdcReserve ?? 0n,
        tokensSold: state?.tokensSold ?? 0n,
        v2Pair: state?.v2Pair ?? ("0x0" as Address),
        metadataURI: metadataMap.get(entry.address.toLowerCase()) ?? "",
        marketCap: mcap,
        name,
        symbol,
        generation: entry.generation,
        launchpad: entry.launchpad,
        legacy: currentGen !== undefined && entry.generation !== currentGen,
      };
    });
  }, [addressEntries, stateCalls.data, metadataMap, currentGen]);

  return {
    tokens,
    isLoading:
      countQueries.isLoading || addrCalls.isLoading || stateCalls.isLoading,
  };
}
