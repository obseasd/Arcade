"use client";

import { Address, zeroAddress } from "viem";
import { useReadContracts } from "wagmi";

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
}

const FEE_TIERS = [500, 3000, 10000, 20000, 30000];

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

    const pools: V3FactoryPool[] = [];
    if (probesQ.data) {
        for (let i = 0; i < candidateTokens.length; i++) {
            for (let j = 0; j < FEE_TIERS.length; j++) {
                const idx = i * FEE_TIERS.length + j;
                const res = probesQ.data[idx];
                if (res?.status !== "success") continue;
                const addr = res.result as Address;
                if (!addr || addr === zeroAddress) continue;
                pools.push({
                    pool: addr,
                    token: candidateTokens[i],
                    feePip: FEE_TIERS[j],
                });
            }
        }
    }

    return {
        pools,
        isLoading: v2Loading || probesQ.isLoading,
    };
}
