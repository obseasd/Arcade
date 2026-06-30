import type { Address } from "viem";
import { ADDRESSES } from "./constants";

/**
 * Every ArcadeLaunchpad contract address that has ever held tokens on
 * Arc testnet. The list lives in ONE place because both the server-side
 * stats scan and the client-side useLaunchpadTokens hook need the same
 * source of truth, otherwise the /my-tokens portfolio shows fewer
 * tokens than /stats says exist.
 *
 * Ordering convention: NEWEST first. The top entry is the live
 * launchpad generation (it equals ADDRESSES.launchpad in normal
 * operation). Subsequent entries are prior generations in reverse
 * chronological order, the same convention used by the
 * PREDECESSOR_CONTRACTS list in lib/stats.ts.
 *
 * Add a new entry at the top of KNOWN_LAUNCHPADS whenever the launchpad
 * is redeployed.
 *
 * The oldest generation on Arc testnet that ever held tokens is gen 4;
 * gens 1-3 were dev-only deploys that never received user launches and
 * are intentionally omitted. OLDEST_GENERATION encodes that floor so
 * the generation numbers below are derived, not hand-maintained.
 */
const KNOWN_LAUNCHPADS: Address[] = [
    "0x4339522dAaaBBCc2888681d53a19901e7a31cb39", // gen 10 (2026-06-30, escrow rewire) — current live
    "0x7337789D6F0f731BCBE6CE6a44334F548Bba56b9", // gen 9 (2026-06-21, pre-Path-B live stack)
    "0xD863e3475E00550FBe0Abf4F1127B673E65C86a4", // gen 8 (2026-06-11, audit v2 prep)
    "0x62aC6A355D092267a93a1Ffb13B7D1c121A5c0e8", // gen 7 (2026-06-09, audit-3 batch)
    "0xB15282e3a0c67989013c7bdc6cd6f4Fa0CdbaAd6", // gen 6 (2026-06-08)
    "0xF441D73C69f00bf2A11019024A80D46a06bE2BdC", // gen 5 (2026-06-07)
    "0xb621925D1aa0f1c2BeC6612Add5290F04F6c3168", // gen 4 (2026-06-01)
];

/** Lowest generation number that ever held user tokens (gens 1-3 were
 *  dev-only and are omitted from KNOWN_LAUNCHPADS). */
const OLDEST_GENERATION = 4;

const ZERO = "0x0000000000000000000000000000000000000000";

export interface LaunchpadGeneration {
    /** Contract address of the launchpad for this generation. */
    address: Address;
    /** 1-indexed generation number. Highest = current live launchpad. */
    generation: number;
    /** True for the live launchpad — writes target only this entry. The
     *  older entries are read-only history sources. */
    isCurrent: boolean;
}

/** All launchpad generations, newest first.
 *
 *  Audit 2026-06-18b: previously this pushed `ADDRESSES.launchpad` as a
 *  separate "gen N+1+3" entry AND iterated PRIOR_LAUNCHPADS which
 *  ALREADY contained the same current address as its top entry. The
 *  result: the live launchpad appeared TWICE in the list (once as gen
 *  9, once as gen 8) with a wrong gen number, and getLaunchpadAddressList()
 *  returned the address twice — which made lib/stats.ts double-count the
 *  current generation's launchpad volume and token-launched count.
 *
 *  Fixed by deduping against ADDRESSES.launchpad and deriving the gen
 *  number from a single newest-first ordering anchored at
 *  OLDEST_GENERATION. The current launchpad is now whichever address is
 *  ADDRESSES.launchpad (matched in the deduped list), or the top entry
 *  when ADDRESSES.launchpad is unset.
 */
export function getLaunchpadGenerations(): LaunchpadGeneration[] {
    const current = ADDRESSES.launchpad;
    const hasCurrent = !!current && current !== ZERO;

    // Build a deduped, newest-first address list. If the configured
    // launchpad is not already the top of KNOWN_LAUNCHPADS (fresh
    // redeploy whose address hasn't been prepended yet), surface it
    // first so writes still target the live contract.
    const ordered: Address[] = [];
    const seen = new Set<string>();
    const push = (a: Address) => {
        const k = a.toLowerCase();
        if (a === ZERO || seen.has(k)) return;
        seen.add(k);
        ordered.push(a);
    };
    if (hasCurrent) push(current);
    KNOWN_LAUNCHPADS.forEach(push);

    // Newest-first: index 0 is the highest gen, last index is
    // OLDEST_GENERATION. With 5 known launchpads the top is gen
    // OLDEST_GENERATION + 4 = gen 8.
    const topGen = OLDEST_GENERATION + ordered.length - 1;
    const currentLower = current?.toLowerCase();
    return ordered.map((address, i) => ({
        address,
        generation: topGen - i,
        isCurrent: hasCurrent && address.toLowerCase() === currentLower,
    }));
}

/** Convenience: just the addresses, newest first. Used by stats.ts for
 *  the eth_getLogs windowed scan. */
export function getLaunchpadAddressList(): Address[] {
    return getLaunchpadGenerations().map((g) => g.address);
}
