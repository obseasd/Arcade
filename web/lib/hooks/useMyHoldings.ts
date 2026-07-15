"use client";

import { useMemo } from "react";
import { Address, erc20Abi } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { ADDRESSES } from "@/lib/constants";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { useLaunchpadTokens, type LaunchpadTokenInfo } from "./useLaunchpadTokens";

export interface HoldingInfo {
    token: LaunchpadTokenInfo;
    /** Raw balance in base units (18 decimals). */
    balance: bigint;
    /** USD value of the holding, computed as `marketCap * balance / totalSupply`.
     *  Undefined when the launchpad doesn't expose a market cap (eg the token
     *  has no on-chain price yet). Raw USDC base units (6 decimals). */
    valueUsdcRaw: bigint | undefined;
}

/**
 * Returns the V2/V3 launchpad tokens where the connected wallet has a
 * non-zero balance, sorted by USD value desc (then by balance). Used by
 * the MyTokens "Held by you" section.
 *
 * Skips tokens the user CREATED (those already appear in the "Launched by
 * you" section above) - the unified view is meant to surface holdings the
 * user might have forgotten about.
 *
 * V4 launches are NOT included here yet; they live in a separate listing
 * behind the V4_ENABLED flag. We can union them in a follow-up once V4 is
 * live in prod.
 */
export function useMyHoldings(): { holdings: HoldingInfo[]; isLoading: boolean } {
    const { address: account } = useAccount();
    const { tokens, isLoading: tokensLoading } = useLaunchpadTokens();

    const candidates = useMemo(() => {
        if (!account) return [];
        // Include EVERY token the user has a balance in, even ones they
        // launched. Originally we excluded self-launches assuming they
        // already showed in "Launched by you", but users buy back their
        // own tokens and want to see the position alongside other holdings.
        return tokens;
    }, [tokens, account]);

    const balanceCalls = useReadContracts({
        contracts: candidates.map((t) => ({
            address: t.address,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [account!] as const,
        })),
        query: { enabled: !!account && candidates.length > 0, refetchInterval: 30_000 },
    });

    // marketCap() prices CIRCULATING supply, so the value denominator must be
    // circulating too. Dividing by a hardcoded TOTAL_SUPPLY read every migrated
    // holding ~6.4% low (they burn ~60M to DEAD at graduation), and drifted
    // further with any holder burn. Read from the launchpad so the two can
    // never disagree about the denominator.
    const supplyCalls = useReadContracts({
        contracts: candidates.map((t) => ({
            address: ADDRESSES.launchpad,
            abi: LAUNCHPAD_ABI,
            functionName: "circulatingSupply" as const,
            args: [t.address] as const,
        })),
        query: { enabled: !!account && candidates.length > 0, refetchInterval: 30_000 },
    });

    const holdings = useMemo<HoldingInfo[]>(() => {
        if (!balanceCalls.data) return [];
        const out: HoldingInfo[] = [];
        for (let i = 0; i < candidates.length; i++) {
            const r = balanceCalls.data[i];
            if (r?.status !== "success") continue;
            const balance = r.result as bigint;
            if (balance === 0n) continue;
            const token = candidates[i];
            // value = marketCap * (balance / circulatingSupply).
            // marketCap is in USDC raw units (6 dp), balance and supply are 18 dp.
            let valueUsdcRaw: bigint | undefined;
            const supplyRes = supplyCalls.data?.[i];
            const circulating =
                supplyRes?.status === "success" ? (supplyRes.result as bigint) : 0n;
            if (token.marketCap !== undefined && token.marketCap > 0n && circulating > 0n) {
                valueUsdcRaw = (token.marketCap * balance) / circulating;
            }
            out.push({ token, balance, valueUsdcRaw });
        }
        // Sort: by USD value desc, then by raw balance desc when value is
        // unknown.
        out.sort((a, b) => {
            const av = a.valueUsdcRaw ?? 0n;
            const bv = b.valueUsdcRaw ?? 0n;
            if (av !== bv) return bv > av ? 1 : -1;
            return b.balance > a.balance ? 1 : -1;
        });
        return out;
    }, [candidates, balanceCalls.data]);

    return {
        holdings,
        isLoading: tokensLoading || balanceCalls.isLoading,
    };
}
