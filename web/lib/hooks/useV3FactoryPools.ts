"use client";

import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, zeroAddress } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";

import { V3_FACTORY_ABI } from "@/lib/abis/v3-npm";
import { ADDRESSES } from "@/lib/constants";
import { useV2Tokens } from "./useV2Tokens";

/**
 * Lists USDC-quoted V3 pools that exist on the V3 factory but weren't
 * created by the launchpad. The launchpad-managed flow surfaces its own
 * pools through useV3Tokens (mode == CLANKER_V3); this hook complements it
 * by walking every known token (V2 + SeedETH) cross the canonical fee tier
 * grid and probing factory.getPool. Non-zero results are real V3 pools.
 *
 * Not an indexer - bounded by the set of tokens we already enumerate, so a
 * V3 pool whose non-USDC token is unknown to the frontend stays invisible
 * until the indexer (ArcLens) ships. Good enough to surface manually-
 * created USDC/SeedETH-style pools in /explore while keeping the cost
 * to one multicall.
 */
export interface V3FactoryPool {
    pool: Address;
    /** Non-USDC token paired in this V3 pool. */
    token: Address;
    /** Pool fee in pip (eg 3000 == 0.30%). */
    feePip: number;
    /** Approximate TVL = USDC.balanceOf(pool) * 2 (assumes 50/50 USDC-token
     *  weighting at current price; over-counts for out-of-range positions and
     *  CLANKER_V3 single-sided launches). Best we can do without a price
     *  feed for the non-USDC leg. Replaces with the indexer's value when
     *  ArcLens ships. */
    tvlUsdc: bigint;
}

// 2026-06-15 audit fix: prepend 100 so the 0.01% tier (canonical Arc
// stable-stable fee) is probed. DeploySecurityV3.s.sol enables 100,
// v3-math.ts maps 100:1, arcadeV3.ts/cron route include 100 in
// ARCADE_V3_FEE_TIERS, and CreatePoolModal exposes the tier — without
// it, USDC/USDT-style V3 pools were invisible in /explore.
const FEE_TIERS = [100, 500, 3000, 10000, 20000, 30000];

export function useV3FactoryPools(extraTokens: Address[] = []): {
    pools: V3FactoryPool[];
    isLoading: boolean;
} {
    const { tokens: v2Tokens, isLoading: v2Loading } = useV2Tokens();
    const factoryEnabled = ADDRESSES.v3Factory !== zeroAddress;

    // Union the v2 token universe with any caller-provided extras (eg
    // SeedETH, which doesn't necessarily have a v2 pair on the current
    // factory generation but does have V3 pools).
    const seedEth = ADDRESSES.seedEth !== zeroAddress ? [ADDRESSES.seedEth] : [];
    const candidateTokens: Address[] = (() => {
        const seen = new Set<string>();
        const out: Address[] = [];
        for (const t of [...v2Tokens.map((t) => t.address), ...seedEth, ...extraTokens]) {
            const k = t.toLowerCase();
            if (seen.has(k)) continue;
            if (k === ADDRESSES.usdc.toLowerCase()) continue;
            seen.add(k);
            out.push(t);
        }
        return out;
    })();

    // One readContract per (token, fee) probe. Cheap to multicall; expensive
    // to subscribe to PoolCreated events on a public RPC, so this scales
    // better in practice for our token count (< 100 in testnet).
    const probes = candidateTokens.flatMap((t) =>
        FEE_TIERS.map((fee) => ({
            address: ADDRESSES.v3Factory,
            abi: V3_FACTORY_ABI,
            functionName: "getPool" as const,
            args: [ADDRESSES.usdc, t, fee] as const,
        })),
    );

    const probesQ = useReadContracts({
        contracts: probes,
        query: { enabled: factoryEnabled && candidateTokens.length > 0 },
    });

    const poolsBare: Omit<V3FactoryPool, "tvlUsdc">[] = [];
    if (probesQ.data) {
        for (let i = 0; i < candidateTokens.length; i++) {
            for (let j = 0; j < FEE_TIERS.length; j++) {
                const idx = i * FEE_TIERS.length + j;
                const res = probesQ.data[idx];
                if (res?.status !== "success") continue;
                const addr = res.result as Address;
                if (!addr || addr === zeroAddress) continue;
                poolsBare.push({
                    pool: addr,
                    token: candidateTokens[i],
                    feePip: FEE_TIERS[j],
                });
            }
        }
    }

    // 2026-06-16 fix: replaced useReadContracts (multicall) with a
    // Promise.all of individual readContract calls keyed by the pool
    // address list. The previous version surfaced "—" TVL for every V3
    // pool in /explore even when the pool detail page (same chain, same
    // wallet, same RPC) read the USDC balance just fine. Root cause:
    // multicall3 is intentionally NOT configured on Arc (memo
    // arc-multicall3-trap), and the batch-fallback path in
    // useReadContracts is brittle on Arc's public RPC (intermittent
    // empty 200-OK responses on getLogs and batched eth_call, observed
    // 2026-06-15). Individual reads via the wagmi-injected publicClient
    // are the same code path that works on the pool detail page.
    const publicClient = usePublicClient();
    const poolAddrKey = useMemo(
        () => poolsBare.map((p) => p.pool).join(","),
        [poolsBare],
    );
    const [usdcBalances, setUsdcBalances] = useState<Map<string, bigint>>(
        new Map(),
    );
    const [balanceLoading, setBalanceLoading] = useState(false);

    useEffect(() => {
        if (!publicClient || poolsBare.length === 0) {
            setUsdcBalances(new Map());
            return;
        }
        let cancelled = false;
        setBalanceLoading(true);
        (async () => {
            const reads = await Promise.all(
                poolsBare.map((p) =>
                    publicClient
                        .readContract({
                            address: ADDRESSES.usdc,
                            abi: erc20Abi,
                            functionName: "balanceOf",
                            args: [p.pool],
                        })
                        .then(
                            (r) => ({ pool: p.pool.toLowerCase(), bal: r as bigint }),
                            () => ({ pool: p.pool.toLowerCase(), bal: 0n }),
                        ),
                ),
            );
            if (cancelled) return;
            const m = new Map<string, bigint>();
            for (const r of reads) m.set(r.pool, r.bal);
            setUsdcBalances(m);
            setBalanceLoading(false);
        })();
        return () => {
            cancelled = true;
        };
        // poolAddrKey is the stable join of every pool address. Listing
        // it explicitly stops the effect from re-firing on every render
        // (poolsBare is a new array each render) while still rerunning
        // when the underlying pool set changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [publicClient, poolAddrKey]);

    const pools: V3FactoryPool[] = poolsBare.map((p) => {
        const usdcBal = usdcBalances.get(p.pool.toLowerCase()) ?? 0n;
        return { ...p, tvlUsdc: usdcBal * 2n };
    });

    return {
        pools,
        isLoading: v2Loading || probesQ.isLoading || balanceLoading,
    };
}
