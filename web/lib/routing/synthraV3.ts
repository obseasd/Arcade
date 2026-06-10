import { ADDRESSES, SYNTHRA_V3_FEES } from "@/lib/constants";
import { createV3ForkProvider } from "./createV3ForkProvider";

/**
 * Synthra V3 provider. Audit A-2: collapsed to a config object since the
 * underlying behaviour (V3 fork + Permit2 + UniversalRouter) is shared
 * with every other vanilla V3 fork on Arc. The factory implementation
 * lives in `createV3ForkProvider.ts`; tests cover both shapes.
 *
 * Pivot token = USDC enables the through-USDC fallback for non-USDC
 * pairs (audit R-3): when direct (X -> Y) returns no pool, the factory
 * tries (X -> USDC -> Y) automatically.
 */
export const synthraV3Provider = createV3ForkProvider({
    id: "synthra-v3",
    factory: ADDRESSES.synthraFactory,
    quoter: ADDRESSES.synthraQuoter,
    ur: ADDRESSES.synthraUniversalRouter,
    feeTiers: SYNTHRA_V3_FEES,
    pivotToken: ADDRESSES.usdc,
});
