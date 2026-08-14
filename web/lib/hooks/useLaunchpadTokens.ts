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
    // staleTime: 60s keeps the count fresh enough that a new launch
    //   surfaces on the next tick, AND keeps a recently-mounted Launchpad
    //   page from re-firing the whole multicall chain when the user comes
    //   back from a token detail page.
    // gcTime: 30 min keeps the data in memory across unmount/remount so
    //   the Unnamed/0x0 fallback never appears just because the user
    //   navigated away for a few seconds.
    query: { enabled: generations.length > 0, staleTime: 60_000, gcTime: 1_800_000 },
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
    // Address-list is append-only on chain: a launchpad never removes a
    // token index. 5-minute staleTime is safe; gcTime carries the cache
    // across remounts so the back-from-detail navigation hits cache.
    query: { enabled: addrCallSpecs.length > 0, staleTime: 300_000, gcTime: 1_800_000 },
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
    // staleTime: 30s is the right cadence for marketCap + realUsdcReserve
    //   (the live trading data); the watchEvent above force-refetches the
    //   whole chain when a new TokenCreated event fires.
    // gcTime: 30 min keeps name/symbol/creator in memory across page
    //   navigation. Without it, every Launchpad re-mount refires the
    //   full multicall and Arc's public RPC starts rate-limiting at the
    //   ~50-token mark, leaving the page stuck on "Unnamed / 0x0".
    query: { enabled: addressEntries.length > 0, staleTime: 30_000, gcTime: 1_800_000 },
  });

  // -------- Goldsky-primary token list --------
  // The launchpad list renders straight from the Goldsky `Token` entity
  // (one GraphQL query for every token across every generation) so the page
  // is NOT hostage to Arc's public RPC rate-limiting. The RPC multicall chain
  // above stays as an ENRICHMENT source for the two fields Goldsky doesn't
  // carry (tokensSold -> the bonding-progress bar; the exact on-chain
  // marketCap) and as the authoritative generation/launchpad tag. When the
  // RPC 429s, those two degrade gracefully (progress bar reads 0 until it
  // resolves) but the list still fully renders from Goldsky.
  const [goldsky, setGoldsky] = useState<Map<string, GoldskyRow>>(new Map());
  const [goldskyDone, setGoldskyDone] = useState(false);
  // metadataMap is the RPC getLogs fallback for metadataURI, only used when
  // Goldsky is unset/unreachable (Goldsky rows already carry their URI).
  const [metadataMap, setMetadataMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const goldskyUrl = process.env.NEXT_PUBLIC_GOLDSKY_URL;
      if (goldskyUrl) {
        try {
          const res = await fetch(goldskyUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              query:
                "{ tokens(first: 1000) { id creator mode createdAt migrated migratedAt migratedPair name symbol metadataURI usdcLiquidity } }",
            }),
          });
          if (res.ok) {
            const j = (await res.json()) as { data?: { tokens?: GoldskyToken[] } };
            const rows = j?.data?.tokens ?? [];
            if (!cancelled && rows.length > 0) {
              const map = new Map<string, GoldskyRow>();
              for (const t of rows) map.set(t.id.toLowerCase(), toGoldskyRow(t));
              setGoldsky(map);
              setGoldskyDone(true);
              return; // served by Goldsky -> skip the RPC getLogs metadata scan
            }
          }
        } catch {
          /* fall through to the RPC metadata scan below */
        }
      }
      setGoldskyDone(true);
      // ---- Fallback: per-generation getLogs scan for metadataURI only ----
      if (!publicClient || addresses.length === 0) return;
      try {
        const latest = await publicClient.getBlockNumber();
        const SCAN_CONCURRENCY = 3;
        const map = new Map<string, string>();
        for (let bi = 0; bi < generations.length; bi += SCAN_CONCURRENCY) {
          if (cancelled) return;
          const batch = generations.slice(bi, bi + SCAN_CONCURRENCY);
          await Promise.all(batch.map(async (g) => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const logs = await scanLogsChunked<any>(
                publicClient,
                { address: g.address, event: TOKEN_CREATED_EVT },
                latest,
                { chunk: CHUNK_SMALL, maxBack: MAX_BACK_BLOCKS, label: `lp.TokenCreated.gen${g.generation}` },
              );
              for (const log of logs) {
                const tokenAddr = (log.args.token as string).toLowerCase();
                const uri = (log.args.metadataURI as string) ?? "";
                if (!map.has(tokenAddr)) map.set(tokenAddr, uri);
              }
            } catch {
              // single-generation failure should not abort the batch
            }
          }));
          if (!cancelled) setMetadataMap(new Map(map));
        }
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, addresses.length, generations]);

  const currentGen = generations.find((g) => g.isCurrent)?.generation;

  // RPC generation/launchpad tag + state enrichment, keyed by lowercase addr.
  const rpcByAddr = useMemo(() => {
    const map = new Map<
      string,
      { generation: number; launchpad: Address; state?: RpcState; mcap?: bigint; name?: string; symbol?: string }
    >();
    addressEntries.forEach((entry, i) => {
      const lc = entry.address.toLowerCase();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = stateCalls.data?.[4 * i]?.result as RpcState | undefined;
      const mcap = stateCalls.data?.[4 * i + 1]?.result as bigint | undefined;
      const name = stateCalls.data?.[4 * i + 2]?.result as string | undefined;
      const symbol = stateCalls.data?.[4 * i + 3]?.result as string | undefined;
      map.set(lc, { generation: entry.generation, launchpad: entry.launchpad, state, mcap, name, symbol });
    });
    return map;
  }, [addressEntries, stateCalls.data]);

  const tokens: LaunchpadTokenInfo[] = useMemo(() => {
    // Union of every address Goldsky knows about and every address the RPC
    // address-list resolved, so neither source alone drops a token.
    const keys = new Set<string>([...goldsky.keys(), ...rpcByAddr.keys()]);
    const out: LaunchpadTokenInfo[] = [];
    for (const lc of keys) {
      const g = goldsky.get(lc);
      const r = rpcByAddr.get(lc);
      const s = r?.state;
      // Goldsky ids and the lowercase key are valid address representations
      // (viem accepts all-lowercase in reads); prefer Goldsky's stored form.
      const address = (g?.address ?? (lc as Address)) as Address;
      out.push({
        address,
        creator: (s?.creator ?? g?.creator ?? "0x0000000000000000000000000000000000000000") as Address,
        createdAt: s?.createdAt ?? g?.createdAt ?? 0n,
        migratedAt: s?.migratedAt ?? g?.migratedAt ?? 0n,
        migrated: s ? !!s.migrated : g?.migrated ?? false,
        mode: s ? Number(s.mode) : g?.mode ?? 0,
        realUsdcReserve: s?.realUsdcReserve ?? g?.realUsdcReserve ?? 0n,
        // Goldsky doesn't index tokensSold; only the RPC state carries it.
        tokensSold: s?.tokensSold ?? 0n,
        v2Pair: (s?.v2Pair ?? g?.v2Pair ?? "0x0000000000000000000000000000000000000000") as Address,
        metadataURI: g?.metadataURI || metadataMap.get(lc) || "",
        // Goldsky doesn't index the exact on-chain marketCap; RPC-only.
        marketCap: r?.mcap,
        name: r?.name ?? g?.name,
        symbol: r?.symbol ?? g?.symbol,
        generation: r?.generation,
        launchpad: r?.launchpad,
        legacy: r ? currentGen !== undefined && r.generation !== currentGen : undefined,
      });
    }
    return out;
  }, [goldsky, rpcByAddr, metadataMap, currentGen]);

  return {
    tokens,
    // Only block on a spinner when we have nothing to show yet. Once Goldsky
    // (or the RPC chain) yields any row, render it and let enrichment stream in.
    isLoading:
      tokens.length === 0 &&
      (!goldskyDone || countQueries.isLoading || addrCalls.isLoading || stateCalls.isLoading),
  };
}

// ---- Goldsky Token entity plumbing ----
interface GoldskyToken {
  id: string;
  creator: string | null;
  mode: number | null;
  createdAt: string | number | null;
  migrated: boolean | null;
  migratedAt: string | number | null;
  migratedPair: string | null;
  name: string | null;
  symbol: string | null;
  metadataURI: string | null;
  usdcLiquidity: string | null;
}

interface GoldskyRow {
  address: Address;
  creator: Address;
  mode: number;
  createdAt: bigint;
  migrated: boolean;
  migratedAt: bigint;
  v2Pair: Address;
  name?: string;
  symbol?: string;
  metadataURI: string;
  realUsdcReserve: bigint;
}

/** On-chain launchpad getTokenState() shape (subset we read). */
interface RpcState {
  creator?: Address;
  createdAt?: bigint;
  migratedAt?: bigint;
  migrated?: boolean;
  mode?: number | bigint;
  realUsdcReserve?: bigint;
  tokensSold?: bigint;
  v2Pair?: Address;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Parse a decimal USDC string ("321.615143") into 6-decimal micro units. */
function usdcToMicro(s: string | null | undefined): bigint {
  if (!s) return 0n;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.round(n * 1e6));
}

function toGoldskyRow(t: GoldskyToken): GoldskyRow {
  return {
    address: (t.id as Address) ?? ZERO,
    creator: (t.creator as Address) ?? ZERO,
    mode: Number(t.mode ?? 0),
    createdAt: BigInt(Math.trunc(Number(t.createdAt ?? 0))),
    migrated: !!t.migrated,
    migratedAt: BigInt(Math.trunc(Number(t.migratedAt ?? 0))),
    v2Pair: (t.migratedPair as Address) ?? ZERO,
    name: t.name ?? undefined,
    symbol: t.symbol ?? undefined,
    metadataURI: t.metadataURI ?? "",
    realUsdcReserve: usdcToMicro(t.usdcLiquidity),
  };
}
