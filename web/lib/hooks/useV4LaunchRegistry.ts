"use client";

import { useMemo } from "react";
import { Address } from "viem";
import { useV4LaunchpadTokens } from "./useV4LaunchpadTokens";

/**
 * Lightweight detector: given a token address, returns whether that token
 * was launched through the V4 launchpad (and therefore trades exclusively
 * on a V4 pool, not on V2/V3).
 *
 * Used by the swap UI and aggregator to short-circuit routing: V4 tokens
 * cannot be swapped through the V2/V3 MultiSwap aggregator yet (extending
 * the aggregator contract to also route V4 is a separate work-item -
 * `contracts/src/swap/ArcadeMultiSwap.sol` would need a V4 leg via
 * `ArcadeV4SwapRouter`). Until that ships, the frontend nudges users to
 * the dedicated V4 swap panel on the token detail page.
 *
 * Gated by V4_ENABLED so this is a no-op in environments where V4 is off.
 */
export function useV4LaunchRegistry(): {
    isV4Token: (token: Address | undefined) => boolean;
    addresses: Set<string>;
    isLoading: boolean;
} {
    const { tokens, isLoading } = useV4LaunchpadTokens();

    const addresses = useMemo(() => {
        return new Set(tokens.map((t) => t.address.toLowerCase()));
    }, [tokens]);

    const isV4Token = useMemo(() => {
        return (token: Address | undefined) =>
            !!token && addresses.has(token.toLowerCase());
    }, [addresses]);

    return { isV4Token, addresses, isLoading };
}
