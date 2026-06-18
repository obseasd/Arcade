"use client";

import { useMemo } from "react";
import { Address, zeroAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ARCADE_HOOK_ABI } from "@/lib/abis/arcadeHook";
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
 *
 * Audit 2026-06-18 H-11 + H-12:
 *   - V4 ArcadeHook graduations now count toward the tier (previously
 *     V4-only creators stayed at "none" forever).
 *   - CLANKER_V3 (mode 2) launches NO LONGER count. They skip the
 *     bonding curve entirely and only pay the 3 USDC creation fee, so
 *     a scammer could mint 10 worthless CLANKER_V3 launches for 30
 *     USDC and earn a Diamond tier badge. Tier now strictly tracks
 *     "tokens that successfully bonded past a real curve threshold".
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
    const hookEnabled =
        !!creator &&
        creator !== zeroAddress &&
        ADDRESSES.arcadeHook !== zeroAddress;

    // ===== V2 launchpad path =====
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

    const v2BondedCount = useMemo(() => {
        if (!creator || !statesQ.data) return 0;
        const lcCreator = creator.toLowerCase();
        let n = 0;
        for (const r of statesQ.data) {
            if (r.status !== "success") continue;
            // tokens(addr) returns a positional tuple: the typed wagmi
            // result is an array. Index 1 = creator, 4 = mode, 7 = migrated.
            //
            // Counting rule for the creator tier (audit 2026-06-18 H-12):
            // ONLY tokens that crossed the bonding-curve graduation
            // threshold count. CLANKER_V3 (mode 2) launches skip the
            // curve entirely and pay only the 3 USDC creation fee, so
            // counting them as "bonded" let a scammer hand-craft 10
            // worthless CLANKER_V3 tokens for 30 USDC and earn Diamond.
            // Bond is the gate; CLANKER_V3 = locked LP at creation, no
            // bond demonstrated.
            const tuple = r.result as readonly unknown[];
            const tokenCreator = (tuple?.[1] as Address | undefined)?.toLowerCase();
            const migrated = Boolean(tuple?.[7]);
            if (tokenCreator === lcCreator && migrated) n += 1;
        }
        return n;
    }, [creator, statesQ.data]);

    // ===== V4 ArcadeHook path (H-11) =====
    // Walks ArcadeHook's allTokens registry the same way the V2 path
    // walks the launchpad's. Each hook token's curve state carries
    // (creator, status); status == 2 means Graduated (post-bond). The
    // hook surface only exists once ADDRESSES.arcadeHook is wired so
    // every read is gated on hookEnabled.
    const hookCountQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "tokensCount",
        query: { enabled: hookEnabled },
    });
    const hookTotal = Number((hookCountQ.data as bigint | undefined) ?? 0n);
    const hookTokensQ = useReadContracts({
        contracts: Array.from({ length: hookTotal }, (_, i) => ({
            address: ADDRESSES.arcadeHook,
            abi: ARCADE_HOOK_ABI,
            functionName: "allTokens" as const,
            args: [BigInt(i)] as const,
        })),
        query: { enabled: hookEnabled && hookTotal > 0 },
    });
    const hookTokenAddrs: Address[] = useMemo(() => {
        if (!hookTokensQ.data) return [];
        return hookTokensQ.data
            .map((r) => (r.status === "success" ? (r.result as Address) : null))
            .filter((a): a is Address => !!a);
    }, [hookTokensQ.data]);
    const hookPoolIdsQ = useReadContracts({
        contracts: hookTokenAddrs.map((addr) => ({
            address: ADDRESSES.arcadeHook,
            abi: ARCADE_HOOK_ABI,
            functionName: "poolIdOf" as const,
            args: [addr] as const,
        })),
        query: { enabled: hookEnabled && hookTokenAddrs.length > 0 },
    });
    const hookPoolIds: `0x${string}`[] = useMemo(() => {
        if (!hookPoolIdsQ.data) return [];
        return hookPoolIdsQ.data
            .map((r) =>
                r.status === "success"
                    ? (r.result as `0x${string}`)
                    : null,
            )
            .filter((p): p is `0x${string}` => !!p && p !== "0x0000000000000000000000000000000000000000000000000000000000000000");
    }, [hookPoolIdsQ.data]);
    const hookStatesQ = useReadContracts({
        contracts: hookPoolIds.map((poolId) => ({
            address: ADDRESSES.arcadeHook,
            abi: ARCADE_HOOK_ABI,
            functionName: "getCurveState" as const,
            args: [poolId] as const,
        })),
        query: { enabled: hookEnabled && hookPoolIds.length > 0 },
    });
    const v4BondedCount = useMemo(() => {
        if (!creator || !hookStatesQ.data) return 0;
        const lcCreator = creator.toLowerCase();
        let n = 0;
        for (const r of hookStatesQ.data) {
            if (r.status !== "success") continue;
            // getCurveState returns a struct: status field (uint8) is
            // 0=Curving, 1=GraduationStarted, 2=Graduated (see
            // contracts/v4src/ArcadeHook.sol line 106). Only fully
            // graduated launches count.
            const state = r.result as
                | { creator?: Address; status?: number }
                | undefined;
            const tokenCreator = state?.creator?.toLowerCase();
            const status = Number(state?.status ?? 0);
            if (tokenCreator === lcCreator && status === 2) n += 1;
        }
        return n;
    }, [creator, hookStatesQ.data]);

    const bondedCount = v2BondedCount + v4BondedCount;

    return {
        bondedCount,
        tier: tierFor(bondedCount),
        isLoading:
            !!enabled &&
            (countQ.isLoading || tokensQ.isLoading || statesQ.isLoading ||
                (hookEnabled && (hookCountQ.isLoading || hookTokensQ.isLoading ||
                    hookPoolIdsQ.isLoading || hookStatesQ.isLoading))),
    };
}
