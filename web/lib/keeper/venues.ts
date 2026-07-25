import type { Address } from "viem";
import type { ProviderId, RouteQuote } from "@/lib/routing/types";
import type { OrbsVenue } from "./orbsRoute";

/**
 * ⚠️ DO NOT ACTIVATE THIS `toVenue` PATH AS-IS. (audit 2026-07-25)
 * `toVenue` below rebuilds each fill as a SINGLE-HOP trade (arcade-v2 hardcodes
 * path=[in,out]; arcade-v3 builds exactInputSingle). That drops the aggregator's
 * via-USDC MULTI-HOP routes and its partialFill clamping, so the committed
 * `quotedOut` (multi-hop price) would not match the executed single-hop trade =>
 * bid-revert loops or mispriced fills. This is exactly the B-1/B-2/B-3 bug that
 * forced the Feature-B revert.
 *
 * CORRECT activation (when ExchangeMulti is deployed): source the swapData from
 * the aggregator's own faithful `RouteQuote.executor` instead of rebuilding it
 * here — re-quote per chunk with amountIn = chunkIn and recipient = the
 * ExchangeMulti adapter, then bidData = (q.amountOut, executor.router,
 * encodeFunctionData(executor)). The executor already carries the real router,
 * the multi-hop path, and the partialFill-clamped amounts, so the whole
 * mismatch class disappears. `selectBestVenue` (the adapter-allowlist filter)
 * stays useful; `toVenue` should be REPLACED, not switched on.
 *
 * ORBS FILL VENUE REGISTRY — the single extension point for "which DEXes can
 * settle a limit / DCA order".
 *
 * The swap aggregator (lib/routing) already knows how to QUOTE every DEX. This
 * registry says, for each of those DEXes, how to turn a winning quote into an
 * Orbs bid: which deployed ExchangeV2 adapter wraps its router, and how to build
 * the venue (router + swap params). The keeper quotes all providers via the SAME
 * aggregator, keeps the ones with a registry entry, and bids the best on its
 * adapter (Ask.exchange=0 lets it pick per fill).
 *
 * ADD A NEW DEX (works across swap AND limit/DCA/multiswap at once):
 *   1. Implement its RouteProvider in lib/routing/<dex>.ts and register it in
 *      lib/routing/aggregate.ts (this already makes SWAP work).
 *   2. Deploy an ExchangeV2 for its router, allowlisting the keeper, and put the
 *      address in the env below.
 *   3. Add ONE entry here (providerId -> adapter + toVenue). Done -- the keeper
 *      picks it up automatically for limit/DCA, and multiswap already uses the
 *      aggregator.
 *
 * Only APPROVE-TO-ROUTER venues (the adapter does `approve(router); call(router,
 * swapData)`) belong here. Permit2 UniversalRouter venues (Synthra/UnitFlow) and
 * V4 need a Permit2/V4-aware adapter first (later phases); omitting them here
 * just means the keeper won't settle a limit order on them yet -- swap still can.
 */
export interface OrbsVenueAdapter {
    providerId: ProviderId;
    /** Deployed ExchangeV2 for this venue's router; undefined = not wired yet. */
    adapter: Address | undefined;
    /** The router the adapter wraps (must match the deployed ExchangeV2's). */
    router: Address;
    /** Build the OrbsVenue for a single-hop src->dst fill from a winning quote. */
    toVenue: (q: RouteQuote, tokenIn: Address, tokenOut: Address) => OrbsVenue;
}

const env = (k: string): Address | undefined => {
    const v = process.env[k];
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
};

/**
 * Build the registry from the live router addresses + per-venue adapter envs.
 * A function (not a const) so the keeper reads fresh env at call time and tests
 * can inject addresses.
 */
export function orbsVenueRegistry(routers: {
    arcadeV2: Address;
    arcadeV3: Address;
    xylonet: Address;
}): OrbsVenueAdapter[] {
    return [
        {
            providerId: "arcade-v2",
            // Reuse the existing V2 adapter env (NEXT_PUBLIC_ORBS_EXCHANGE_V2).
            adapter: env("NEXT_PUBLIC_ORBS_EXCHANGE_V2_ADDRESS") ?? env("ORBS_ADAPTER_ARCADE_V2"),
            router: routers.arcadeV2,
            toVenue: (_q, tokenIn, tokenOut) => ({
                kind: "v2",
                router: routers.arcadeV2,
                path: [tokenIn, tokenOut],
            }),
        },
        {
            providerId: "xylonet-v1",
            adapter: env("ORBS_ADAPTER_XYLONET"),
            router: routers.xylonet,
            toVenue: (_q, tokenIn, tokenOut) => ({
                kind: "v2", // XyloNet exposes a V2-style swapExactTokensForTokens router
                router: routers.xylonet,
                path: [tokenIn, tokenOut],
            }),
        },
        {
            providerId: "arcade-v3",
            adapter: env("ORBS_ADAPTER_ARCADE_V3"),
            router: routers.arcadeV3,
            toVenue: (q, tokenIn, tokenOut) => ({
                kind: "v3",
                router: routers.arcadeV3,
                tokenIn,
                tokenOut,
                // The pool fee tier the quote used; default to 0.30% if absent.
                fee: q.fee ?? 3000,
            }),
        },
    ];
}

export interface SelectedVenue {
    venue: OrbsVenue;
    adapter: Address;
    quotedOut: bigint;
    providerId: ProviderId;
}

/**
 * Pick the best Orbs-fillable venue for a fill: among the aggregator quotes,
 * keep only those with a WIRED adapter in the registry, and take the highest
 * amountOut. Pure + deterministic (ties break by registry order). Returns null
 * when no fillable venue quotes -- the keeper then skips the order this tick.
 */
export function selectBestVenue(
    quotes: RouteQuote[],
    registry: OrbsVenueAdapter[],
    tokenIn: Address,
    tokenOut: Address,
): SelectedVenue | null {
    let best: SelectedVenue | null = null;
    for (const q of quotes) {
        if (q.amountOut <= 0n) continue;
        const cfg = registry.find((r) => r.providerId === q.provider && r.adapter);
        if (!cfg || !cfg.adapter) continue;
        if (best === null || q.amountOut > best.quotedOut) {
            best = {
                venue: cfg.toVenue(q, tokenIn, tokenOut),
                adapter: cfg.adapter,
                quotedOut: q.amountOut,
                providerId: q.provider,
            };
        }
    }
    return best;
}
