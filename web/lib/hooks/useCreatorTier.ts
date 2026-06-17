"use client";

import { useMemo } from "react";
import { Address, zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";

/**
 * Counts the number of bonding-curve launches a creator has shipped
 * AND that have bonded (= migrated past the curve to a real AMM pool).
 *
 * Tier thresholds match the on-prod product copy:
 *   - **silver**  : 3 bonded launches
 *   - **gold**    : 5 bonded launches
 *   - **diamond** : 10 bonded launches
 *
 * Implementation walks `allTokens(i)` for every i in [0, getTokensCount)
 * via multicall, then reads `tokens(addr)` for each to filter by
 * creator + migrated. That's 1 RPC each (round-tripped by Multicall3),
 * so the cost is "two multicalls per creator card" — fine for
 * hundreds of launchpad tokens, would want an indexer past thousands.
 *
 * Returns 0 / "none" when the launchpad address isn't wired or the
 * creator address isn't set; safe to use unconditionally in JSX.
 */
export type CreatorTier = "none" | "silver" | "gold" | "diamond";

export const CREATOR_TIER_THRESHOLDS: Record<
    Exclude<CreatorTier, "none">,
    { min: number; label: string; hint: string }
> = {
    silver: {
        min: 3,
        label: "Silver creator",
        hint: "3+ bonded launches",
    },
    gold: {
        min: 5,
        label: "Gold creator",
        hint: "5+ bonded launches",
    },
    diamond: {
        min: 10,
        label: "Diamond creator",
        hint: "10+ bonded launches",
    },
};

export function tierFor(bondedCount: number): CreatorTier {
    if (bondedCount >= CREATOR_TIER_THRESHOLDS.diamond.min) return "diamond";
    if (bondedCount >= CREATOR_TIER_THRESHOLDS.gold.min) return "gold";
    if (bondedCount >= CREATOR_TIER_THRESHOLDS.silver.min) return "silver";
    return "none";
}

export interface CreatorTierResult {
    bondedCount: number;
    tier: CreatorTier;
    isLoading: boolean;
}

export function useCreatorTier(
    creator: Address | undefined,
): CreatorTierResult {
    const enabled =
        !!creator &&
        creator !== zeroAddress &&
        ADDRESSES.launchpad !== zeroAddress;

    const countQ = useReadContract({
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "getTokensCount",
        query: { enabled },
    });
    const totalCount = Number((countQ.data as bigint | undefined) ?? 0n);

    // Step 1: pull every token address from the launchpad's registry.
    // Multicall coalesces these into a single eth_call now that Arc has
    // a working Multicall3 wired in chains.ts.
    const tokensQ = useReadContracts({
        contracts: Array.from({ length: totalCount }, (_, i) => ({
            address: ADDRESSES.launchpad,
            abi: LAUNCHPAD_ABI,
            functionName: "allTokens" as const,
            args: [BigInt(i)] as const,
        })),
        query: { enabled: enabled && totalCount > 0 },
    });

    const tokenAddrs: Address[] = useMemo(() => {
        if (!tokensQ.data) return [];
        return tokensQ.data
            .map((r) => (r.status === "success" ? (r.result as Address) : null))
            .filter((a): a is Address => !!a);
    }, [tokensQ.data]);

    // Step 2: read the per-token state to grab (creator, migrated).
    // We could chain into batches but multicall handles the fan-out fine.
    const statesQ = useReadContracts({
        contracts: tokenAddrs.map((addr) => ({
            address: ADDRESSES.launchpad,
            abi: LAUNCHPAD_ABI,
            functionName: "tokens" as const,
            args: [addr] as const,
        })),
        query: { enabled: enabled && tokenAddrs.length > 0 },
    });

    const bondedCount = useMemo(() => {
        if (!creator || !statesQ.data) return 0;
        const lcCreator = creator.toLowerCase();
        let n = 0;
        for (const r of statesQ.data) {
            if (r.status !== "success") continue;
            // tokens(addr) returns a positional tuple: the typed wagmi
            // result is an array; index 1 is `creator`, index 7 is the
            // `migrated` bool.
            const tuple = r.result as readonly unknown[];
            const tokenCreator = (tuple?.[1] as Address | undefined)?.toLowerCase();
            const migrated = Boolean(tuple?.[7]);
            if (tokenCreator === lcCreator && migrated) n += 1;
        }
        return n;
    }, [creator, statesQ.data]);

    return {
        bondedCount,
        tier: tierFor(bondedCount),
        isLoading:
            !!enabled &&
            (countQ.isLoading || tokensQ.isLoading || statesQ.isLoading),
    };
}
