import { RouteProvider, RouteQuote, QuoteRequest } from "./types";
import { synthraV3Provider } from "./synthraV3";
import { arcadeV4Provider } from "./arcadeV4";
import { arcadeV3Provider } from "./arcadeV3";
import { arcadeV2Provider } from "./arcadeV2";
import { unitflowV3Provider } from "./unitflowV3";
import { xylonetV1Provider } from "./xylonetV1";
import { usycTellerV1Provider } from "./usycTellerV1";

/**
 * Provider fan-out + ranking, with NO React and NO wallet dependency, so the
 * exact same code runs in the browser and inside the /api/routes/quote route.
 * Previously this lived inside useRouteQuotes; it was lifted out when quoting
 * moved server-side so the two paths can never drift into ranking a route
 * differently (the server picks "best", the client renders it).
 *
 * Adding a new DEX:
 *   1. Implement RouteProvider in `lib/routing/<dex>.ts`.
 *   2. Add it to PROVIDERS below.
 *   3. Add the ProviderId + meta in `types.ts`.
 * The aggregator, the API route and the UI's top-N display pick it up
 * automatically.
 */
export const PROVIDERS: RouteProvider[] = [
    arcadeV4Provider,
    arcadeV3Provider,
    arcadeV2Provider,
    synthraV3Provider,
    unitflowV3Provider,
    xylonetV1Provider,
    usycTellerV1Provider,
];

// Audit R-10 / M4: strict total order. An earlier comparator bucketed pairs to
// ~1 bp and used the provider rank inside the bucket, which is not transitive
// across a triple and could make the auto-picked "best" route wrong. Exact-tie
// tiebreak only: native Arcade routes first (no sig dance), then XyloNet
// (V2-ABI, no Permit2 setup), then Synthra, then UnitFlow. Same total cost on a
// tie, cheapest-to-execute wins.
const PROVIDER_RANK: Record<string, number> = {
    "arcade-v4": 0,
    "arcade-v3": 0,
    "arcade-v2": 1,
    "xylonet-v1": 2,
    "synthra-v3": 3,
    "unitflow-v3": 4,
};

export function sortQuotes(quotes: RouteQuote[]): RouteQuote[] {
    const out = [...quotes];
    out.sort((a, b) => {
        if (a.amountOut === b.amountOut) {
            return (PROVIDER_RANK[a.provider] ?? 99) - (PROVIDER_RANK[b.provider] ?? 99);
        }
        return b.amountOut > a.amountOut ? 1 : -1;
    });
    return out;
}

/**
 * Query every provider in parallel and return the surviving quotes, best first.
 * A provider that has no pool, reverts or times out yields null and is dropped:
 * a Synthra outage never blocks Arcade quotes and vice versa.
 */
export async function quoteAllRoutes(
    req: QuoteRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
): Promise<RouteQuote[]> {
    // Same-token in/out is a no-op every provider would reject anyway (audit
    // R-9); skip the fan-out entirely.
    if (req.tokenIn.toLowerCase() === req.tokenOut.toLowerCase()) return [];
    if (req.amountIn <= 0n) return [];
    const results = await Promise.all(
        PROVIDERS.map((p) => p.quote(req, publicClient).catch(() => null)),
    );
    return sortQuotes(results.filter((r): r is RouteQuote => r !== null));
}
