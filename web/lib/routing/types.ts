import { Address } from "viem";

/**
 * Stable identifier for a routing provider. Used in UI labels + analytics +
 * the auto-pick logic. Add a new entry here, register a Provider in
 * `lib/routing/index.ts`, and the aggregator picks it up automatically.
 */
export type ProviderId = "arcade-v3" | "arcade-v2" | "synthra-v3" | "unitflow-v3" | "xylonet-v1";

/**
 * Display metadata shown next to a route card (logo, name, tag color).
 */
export interface ProviderMeta {
  id: ProviderId;
  /** Short name shown on the route chip (e.g. "Arcade V3", "Synthra V3"). */
  label: string;
  /** Long name used in tooltips. */
  longLabel: string;
  /** Tailwind color token for the route accent (e.g. "text-arc-cta-hover"). */
  accent: string;
}

/**
 * Result of a single Provider.quote call.
 *
 * `route` is optional: V3 single-pool routes carry just `fee`, multi-hop
 * routes carry a `path`. The SwapCard renders these in a small caption
 * under the route chip ("0.3% pool" / "USDC -> WETH -> SYN").
 *
 * `executor` is the wagmi-shaped call the SwapCard issues when the user
 * clicks Swap with this route selected: router address, ABI, function
 * name, args (with `recipient` / `amountOutMinimum` / `deadline` already
 * filled in). The SwapCard is responsible for approval + send tx.
 */
export interface RouteQuote {
  provider: ProviderId;
  /** Amount of tokenOut returned by this route for the given amountIn. */
  amountOut: bigint;
  /** Single fee tier if this is a V3 one-hop route, undefined otherwise. */
  fee?: number;
  /** Optional path string for UI display (e.g. "USDC -> WETH -> SYN"). */
  pathLabel?: string;
  /** Token the user must approve to the executor.router before swapping. */
  approval: { token: Address; spender: Address; amount: bigint };
  /** Pre-built execution payload for wagmi useWriteContract. */
  executor: {
    router: Address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abi: any;
    functionName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any[];
    /** ETH value to send (non-zero only for native-asset legs; on Arc
     *  this stays 0 since USDC is the native gas asset). */
    value?: bigint;
  };
}

/**
 * Inputs the Provider needs to build a quote + executor.
 */
export interface QuoteRequest {
  tokenIn: Address;
  tokenOut: Address;
  /** Decimals are passed so providers don't all have to read them again. */
  decimalsIn: number;
  decimalsOut: number;
  amountIn: bigint;
  /** Recipient of tokenOut. Baked into the executor args. */
  recipient: Address;
  /** Slippage in basis points (e.g. 50 = 0.5%). Used to compute amountOutMinimum. */
  slippageBps: number;
  /** Deadline timestamp (seconds). */
  deadline: bigint;
  /** Optional sub-second invalidator so callers can bust the quote cache. */
  signal?: AbortSignal;
}

/**
 * A read-only quote provider. Each AMM / aggregator the app routes through
 * implements this. Providers are independent: a Synthra-only outage does
 * not block Arcade quotes.
 */
export interface RouteProvider {
  meta: ProviderMeta;
  /**
   * Return a RouteQuote with `amountOut` and an executor payload, or null
   * if no pool exists / the route reverts. Should NEVER throw — return null
   * and the aggregator drops this provider for this request.
   */
  quote(
    req: QuoteRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
  ): Promise<RouteQuote | null>;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  "arcade-v3": {
    id: "arcade-v3",
    label: "Arcade V3",
    longLabel: "Arcade Uniswap V3 fork (CLANKER_V3 pools)",
    accent: "text-arc-cta-hover",
  },
  "arcade-v2": {
    id: "arcade-v2",
    label: "Arcade V2",
    longLabel: "Arcade Uniswap V2 fork (launchpad-migrated pairs)",
    accent: "text-sky-400",
  },
  "synthra-v3": {
    id: "synthra-v3",
    label: "Synthra V3",
    longLabel: "Synthra Uniswap V3 fork on Arc testnet",
    accent: "text-emerald-400",
  },
  "unitflow-v3": {
    id: "unitflow-v3",
    label: "UnitFlow V3",
    longLabel: "UnitFlow Finance Uniswap V3 fork on Arc testnet",
    accent: "text-fuchsia-400",
  },
  "xylonet-v1": {
    id: "xylonet-v1",
    label: "XyloNet",
    longLabel: "XyloNet StableSwap (Curve invariant + V2-style router)",
    accent: "text-amber-400",
  },
};
