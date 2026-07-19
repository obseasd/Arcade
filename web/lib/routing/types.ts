import { Address } from "viem";

/**
 * Stable identifier for a routing provider. Used in UI labels + analytics +
 * the auto-pick logic. Add a new entry here, register a Provider in
 * `lib/routing/index.ts`, and the aggregator picks it up automatically.
 */
export type ProviderId = "arcade-v4" | "arcade-v3" | "arcade-v2" | "synthra-v3" | "unitflow-v3" | "xylonet-v1" | "usyc-teller";

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
  /** Pre-built execution payload for wagmi useWriteContract.
   *
   *  For UniversalRouter-backed routes, `args` is a TEMPLATE: the inputs
   *  array contains placeholders the SwapCard fills at exec time after
   *  signing the Permit2 PermitSingle (so the signed `permit` + `signature`
   *  are baked into the PERMIT2_PERMIT command's input). See
   *  `permit2.permitSpender` on the parent quote.
   */
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
  /** Permit2 metadata. Present when the executor is a UniversalRouter
   *  that wants to pull tokens via Permit2 instead of plain ERC20
   *  allowance. SwapCard handles the (a) one-time approve to Permit2,
   *  (b) per-swap EIP-712 sign of the PermitSingle authorising
   *  `permit2.permitSpender`, (c) injection of the permit + signature
   *  into `executor.args` at the index given by `permit2.permitInputIndex`.
   *  When undefined the route falls back to classic ERC20 approval. */
  permit2?: {
    /** Spender to authorise (= the UniversalRouter that will pull tokens). */
    permitSpender: Address;
    /** Index inside `executor.args[1]` (the `inputs[]` array of UR.execute)
     *  where the PERMIT2_PERMIT input lives. SwapCard rewrites this slot
     *  after signing. */
    permitInputIndex: number;
  };
  /** Partial-fill marker. Set when the user's typed amountIn would
   *  exhaust the pool's active liquidity at the current tick, and the
   *  provider clamped the input to the largest amount that still
   *  returns a non-zero quote. The executor's `args` already reflect
   *  the clamped amount (NOT the user's typed amount). SwapCard
   *  surfaces this as a yellow warning above the Swap button so the
   *  user understands the discrepancy between their input and what
   *  the route will actually execute. */
  partialFill?: {
    /** What the user typed. Same as the `amountIn` field of the QuoteRequest. */
    requestedAmountIn: bigint;
    /** What the executor will actually consume. Always <= requestedAmountIn. */
    effectiveAmountIn: bigint;
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
  "arcade-v4": {
    id: "arcade-v4",
    label: "Arcade V4",
    longLabel: "Arcade Uniswap V4 hook pools (CLANKER + graduated PUMP)",
    accent: "text-cyan-400",
  },
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
  "usyc-teller": {
    id: "usyc-teller",
    label: "USYC",
    longLabel: "Hashnote USYC ERC-4626 Teller (subscribe / redeem)",
    accent: "text-sky-400",
  },
};
