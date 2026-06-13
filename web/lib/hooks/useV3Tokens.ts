"use client";

import { Address, erc20Abi, zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V3_POOL_ABI } from "@/lib/abis/v3";
import { ADDRESSES } from "@/lib/constants";

/**
 * Static tokens that we route through the V3 quoter even though they
 * were NOT launched on the bonding-curve launchpad. The classifier
 * below treats every entry here the same way as a CLANKER_V3 launch:
 *   - included in the V3 token set
 *   - default fee tier 0.3% (3000)
 *   - pool address resolved on-demand by the V3 factory
 *
 * Why this exists: SeedETH lives in V3-only pools we created via the
 * /positions/add v3 flow (USDC/SeedETH 0.3%). The default V2 routing
 * path tries getAmountsOut on the V2 router, which reverts when no V2
 * pair exists, and the user sees an infinite "Fetching price…" loop
 * because wagmi retries 3× before settling. Listing SeedETH here flips
 * the routing decision to V3 and the quote returns instantly.
 *
 * Add a token to this list when:
 *   - it has a V3 pool we want to route through
 *   - it does NOT have a V2 pair (or the V2 pair is too thin / stale)
 *   - it is NOT a launchpad token (those are auto-detected from the
 *     launchpad contract below).
 *
 * The proper long-term fix (auto-discover V3 pools via factory and
 * fall back to V3 when V2 is absent) is tracked separately — see the
 * "Fix C" route in the routing roadmap.
 */
const STATIC_V3_TOKENS: Address[] = [];
if (ADDRESSES.seedEth !== zeroAddress) {
    STATIC_V3_TOKENS.push(ADDRESSES.seedEth);
}

/**
 * Lists CLANKER_V3 launch tokens - those that launched directly into a locked
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
  const addrs = (addrCalls.data ?? []).flatMap((c) =>
    c.status === "success" ? [c.result as unknown as Address] : [],
  );

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
  const v3Pools: Address[] = []; // parallel to v3Addrs (the V3 pool per token)
  if (stateCalls.data) {
    for (let i = 0; i < addrs.length; i++) {
      const r = stateCalls.data[i];
      if (r?.status !== "success") continue;
      const tuple = r.result as unknown as readonly unknown[];
      const mode = Number(tuple[4]);
      const migrated = Boolean(tuple[7]);
      if (mode === CLANKER_V3_MODE && migrated) {
        v3Addrs.push(addrs[i]);
        v3Pools.push(tuple[10] as Address); // v2Pair field stores the V3 pool
      }
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

  // Metadata for the static V3 routables (e.g. SeedETH). The /explore
  // page reads token symbols / decimals from the `tokens` array below;
  // without this lookup, any pool whose non-USDC side is a static V3
  // token would render as "USDC / ?" because the explore page's
  // tokenLookup map has no entry for it. Same shape as metaCalls so
  // the spread below treats both sets identically.
  const staticMetaCalls = useReadContracts({
    contracts: STATIC_V3_TOKENS.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "symbol" },
      { address: t, abi: erc20Abi, functionName: "name" },
      { address: t, abi: erc20Abi, functionName: "decimals" },
    ]),
    query: { enabled: STATIC_V3_TOKENS.length > 0 },
  });

  // Each token's pool fee tier (1% / 2% / 3%) so swaps route on the right tier.
  const feeCalls = useReadContracts({
    contracts: v3Pools.map((p) => ({ address: p, abi: V3_POOL_ABI, functionName: "fee" as const })),
    query: { enabled: v3Pools.length > 0 },
  });

  const tokens: V3TokenInfo[] = [
    ...v3Addrs.map((address, i) => ({
      address,
      symbol: metaCalls.data?.[3 * i]?.result as string | undefined,
      name: metaCalls.data?.[3 * i + 1]?.result as string | undefined,
      decimals: metaCalls.data?.[3 * i + 2]?.result as number | undefined,
      isV3: true as const,
    })),
    ...STATIC_V3_TOKENS.map((address, i) => ({
      address,
      symbol: staticMetaCalls.data?.[3 * i]?.result as string | undefined,
      name: staticMetaCalls.data?.[3 * i + 1]?.result as string | undefined,
      decimals: staticMetaCalls.data?.[3 * i + 2]?.result as number | undefined,
      isV3: true as const,
    })),
  ];

  // Map of lowercased V3 address -> fee tier (defaults to 1%).
  const feeMap = new Map<string, number>();
  v3Addrs.forEach((a, i) => {
    const f = feeCalls.data?.[i]?.result as number | undefined;
    feeMap.set(a.toLowerCase(), f ?? 10_000);
  });

  // Map of lowercased V3 token address -> on-chain pool address. Exposed so
  // callers that need the pool itself (eg the explore Open Pool route) don't
  // have to re-resolve via factory.getPool.
  const poolMap = new Map<string, Address>();
  v3Addrs.forEach((a, i) => {
    poolMap.set(a.toLowerCase(), v3Pools[i]);
  });

  // Static V3 routables (e.g. SeedETH): registered with a default 3000 bps
  // fee tier and no pool address — `feeOf` falls back to 3000 when the map
  // hits, and routes that need the pool resolve via factory.getPool at
  // call site. This keeps the legacy "launchpad-only" semantics intact
  // for the rest of the hook while widening the V3 routable set to the
  // static list above.
  for (const a of STATIC_V3_TOKENS) {
    feeMap.set(a.toLowerCase(), 3000);
  }

  // Set of lowercased V3 addresses for quick membership checks. Includes
  // both launchpad-detected and static entries so isV3Token returns true
  // for the V3-only static set as well.
  const v3Set = new Set([
    ...v3Addrs.map((a) => a.toLowerCase()),
    ...STATIC_V3_TOKENS.map((a) => a.toLowerCase()),
  ]);

  return {
    isLoading:
      countQ.isLoading || addrCalls.isLoading || stateCalls.isLoading || metaCalls.isLoading,
    tokens,
    isV3Token: (addr?: Address) => !!addr && v3Set.has(addr.toLowerCase()),
    feeOf: (addr?: Address) => (addr ? feeMap.get(addr.toLowerCase()) ?? 10_000 : 10_000),
    poolOf: (addr?: Address) => (addr ? poolMap.get(addr.toLowerCase()) : undefined),
  };
}
