import type { Address } from "viem";
import type { OrbsVenue } from "./orbsRoute";

/**
 * FAITHFUL direct-venue selection for ExchangeMulti fills.
 *
 * This is the SAFE half of "multi-venue limit/DCA" (the reason venues.ts's
 * `toVenue` is fenced off): here the keeper quotes each venue DIRECTLY at the
 * exact chunk size it will execute, on the exact single-hop route it will
 * execute. quote == execute by construction, so there is no multi-hop /
 * partial-fill reconstruction gap (the B-1/B-2/B-3 class). The committed
 * `quotedOut` in the bid is the same number the swap delivers, modulo the
 * keeper's slippage haircut.
 *
 * Each candidate is a venue the keeper already priced. `pickBestVenue` just
 * takes the highest honest output. Adding a DEX = price it, push a candidate,
 * and `setRouterAllowed(itsRouter, true)` on-chain. No contract redeploy.
 *
 * Only V2-style (approve-to-router `swapExactTokensForTokens` + `getAmountsOut`)
 * venues that accept native USDC are wired today (Arcade V2, XyloNet). V3 single
 * pools can be added the same way (quote `quoteExactInputSingle` at chunkIn, emit
 * a {kind:"v3"} venue) once their router is allow-listed on ExchangeMulti.
 */
export interface DirectVenueCandidate {
    /** Stable label for logging (e.g. "arcade-v2", "xylonet"). */
    label: string;
    /** Output this venue returns for the chunk, quoted at chunkIn on THIS venue. */
    quotedOut: bigint;
    /** The venue to execute — its `router` is what ExchangeMulti allow-lists and
     *  calls, and it is the same router the quote was taken on. */
    venue: OrbsVenue;
}

/**
 * Highest-output candidate, or null if none quote positive. Deterministic:
 * ties break by input order (first wins). Pure — unit-testable in isolation.
 */
export function pickBestVenue(candidates: DirectVenueCandidate[]): DirectVenueCandidate | null {
    let best: DirectVenueCandidate | null = null;
    for (const c of candidates) {
        if (c.quotedOut <= 0n) continue;
        if (best === null || c.quotedOut > best.quotedOut) best = c;
    }
    return best;
}

/** Build a V2-style direct-pair venue (Arcade V2, XyloNet). */
export function v2DirectVenue(router: Address, tokenIn: Address, tokenOut: Address): OrbsVenue {
    return { kind: "v2", router, path: [tokenIn, tokenOut] };
}
