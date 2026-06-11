"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import { useLaunchpadTokens } from "./useLaunchpadTokens";

/**
 * Filters `useLaunchpadTokens()` to PUMP-mode (mode == 0), pre-graduation
 * tokens only. These trade on the bonding curve via `launchpad.buy/sell`
 * and have NEITHER a V2 pair NOR a V3 pool until graduation, so they
 * never showed up in the swap dropdown until this hook landed.
 *
 * Audit 2026-06-11 bug #5: SwapCard's `allTokens` only listed v2Tokens
 * (post-grad pairs) + v3Tokens (CLANKER_V3 mode-2 pools); PUMP pre-grad
 * tokens were invisible. Users had to navigate to `/launchpad/<addr>`
 * manually. This hook surfaces them so they're discoverable; the swap
 * card renders a "Trade on bonding curve" CTA that deep-links to the
 * launchpad detail page rather than attempting to route through the
 * regular AMM aggregator (which has no path).
 */
export interface CurveTokenOption {
  address: Address;
  symbol?: string;
  name?: string;
  decimals: number;
  /** Always 0 (PUMP). */
  mode: 0;
  /** Always false (pre-grad). */
  migrated: false;
  /** Marker the SwapCard uses to recognise the curve route. */
  via: "launchpad-curve";
}

export function useLaunchpadCurveTokens(): {
  tokens: CurveTokenOption[];
  isLoading: boolean;
} {
  const { tokens, isLoading } = useLaunchpadTokens();
  const curveTokens = useMemo(
    () =>
      tokens
        .filter((t) => t.mode === 0 && !t.migrated)
        .map<CurveTokenOption>((t) => ({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          // Launchpad tokens are minted with a fixed 18-decimal supply by
          // the bonding-curve constructor. Hardcoded here so a missing
          // decimals() read on a freshly-created token doesn't drop the
          // entry from the dropdown.
          decimals: 18,
          mode: 0,
          migrated: false,
          via: "launchpad-curve",
        })),
    [tokens],
  );
  return { tokens: curveTokens, isLoading };
}
