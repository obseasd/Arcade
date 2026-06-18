import { ADDRESSES, SYNTHRA_V3_FEES } from "@/lib/constants";
import { createV3ForkProvider } from "./createV3ForkProvider";

/**
 * Synthra V3 provider. Audit A-2: collapsed to a config object since the
 * underlying behaviour (V3 fork + Permit2 + UniversalRouter) is shared
 * with every other vanilla V3 fork on Arc. The factory implementation
 * lives in `createV3ForkProvider.ts`; tests cover both shapes.
 *
 * Audit 2026-06-18 M-19: pivot token MUST be WUSDC, not native USDC.
 * Per constants.ts:107-109, "All V3 pools route through WUSDC (0x911b...)
 * instead of native USDC (0x3600...), so USDC↔X swaps require a wrap
 * step via UniversalRouter". Pivoting through native USDC means the
 * fallback always misses on Synthra (no native-USDC pools exist), so
 * the provider returned null on every non-trivial pair. Pivoting
 * through WUSDC matches Synthra's actual pool topology; the wrap from
 * native USDC to WUSDC is handled at the UR command-stream layer
 * (universalRouter.ts).
 */
export const synthraV3Provider = createV3ForkProvider({
    id: "synthra-v3",
    factory: ADDRESSES.synthraFactory,
    quoter: ADDRESSES.synthraQuoter,
    ur: ADDRESSES.synthraUniversalRouter,
    feeTiers: SYNTHRA_V3_FEES,
    pivotToken: ADDRESSES.synthraWusdc,
});
