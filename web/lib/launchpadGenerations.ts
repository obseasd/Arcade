import type { Address } from "viem";
import { ADDRESSES } from "./constants";

/**
 * Every ArcadeLaunchpad contract address that has ever held tokens on
 * Arc testnet. The list lives in ONE place because both the server-side
 * stats scan and the client-side useLaunchpadTokens hook need the same
 * source of truth, otherwise the /my-tokens portfolio shows fewer
 * tokens than /stats says exist.
 *
 * Ordering convention: NEWEST first. Index 0 is the live launchpad
 * (mirrors ADDRESSES.launchpad). Subsequent entries are prior
 * generations in reverse chronological order, the same convention used
 * by the PREDECESSOR_CONTRACTS list in lib/stats.ts.
 *
 * Add a new entry at the top of PRIOR_LAUNCHPADS whenever the launchpad
 * is redeployed.
 */
const PRIOR_LAUNCHPADS: Address[] = [
    "0xD863e3475E00550FBe0Abf4F1127B673E65C86a4", // gen 8 (2026-06-11, audit v2 prep)
    "0x62aC6A355D092267a93a1Ffb13B7D1c121A5c0e8", // gen 7 (2026-06-09, audit-3 batch)
    "0xB15282e3a0c67989013c7bdc6cd6f4Fa0CdbaAd6", // gen 6 (2026-06-08)
    "0xF441D73C69f00bf2A11019024A80D46a06bE2BdC", // gen 5 (2026-06-07)
    "0xb621925D1aa0f1c2BeC6612Add5290F04F6c3168", // gen 4 (2026-06-01)
];

export interface LaunchpadGeneration {
    /** Contract address of the launchpad for this generation. */
    address: Address;
    /** 1-indexed generation number. Highest = current live launchpad. */
    generation: number;
    /** True for the live launchpad — writes target only this entry. The
     *  older entries are read-only history sources. */
    isCurrent: boolean;
}

/** All launchpad generations, newest first. Filters out the zero address
 *  so an unattached current launchpad doesn't pollute the list. The
 *  current generation count is derived from PRIOR_LAUNCHPADS.length + 1
 *  so the gen numbers stay stable even as new generations are appended.
 */
export function getLaunchpadGenerations(): LaunchpadGeneration[] {
    const current = ADDRESSES.launchpad;
    const totalPriors = PRIOR_LAUNCHPADS.length;
    const currentGen = totalPriors + 1 + 3; // priors start at gen 4
    const list: LaunchpadGeneration[] = [];
    if (current && current !== "0x0000000000000000000000000000000000000000") {
        list.push({ address: current, generation: currentGen, isCurrent: true });
    }
    PRIOR_LAUNCHPADS.forEach((address, i) => {
        list.push({
            address,
            // gen 8, 7, 6, 5, 4 ... for entries 0, 1, 2, 3, 4
            generation: totalPriors - i + 3,
            isCurrent: false,
        });
    });
    return list;
}

/** Convenience: just the addresses, newest first. Used by stats.ts for
 *  the eth_getLogs windowed scan. */
export function getLaunchpadAddressList(): Address[] {
    return getLaunchpadGenerations().map((g) => g.address);
}
