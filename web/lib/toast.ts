"use client";

import { Address } from "viem";

/**
 * Minimal pub/sub toast system. Anywhere in the app can call `pushToast(...)`;
 * the global <Toaster /> mounted in `app/layout.tsx` listens and renders.
 *
 * We use a CustomEvent rather than a context so call sites don't need a hook.
 */

export interface SwapToastPayload {
  kind: "swap";
  /** Address of the token the user received. */
  tokenAddress?: Address;
  tokenSymbol?: string;
  /** Optional logo URL (data: or http(s):) — overrides the symbol-based lookup. */
  tokenImage?: string;
  amountFormatted: string;
  /** Optional block-explorer URL for the receive/mint tx. */
  explorerUrl?: string;
  /** Optional chain id — renders a small chain badge over the token logo
   *  (the chain where the funds landed), like the Activity tab. */
  chainId?: number;
}

export interface InfoToastPayload {
  kind: "info" | "error";
  title: string;
  message?: string;
}

export interface LiquidityToastPayload {
  kind: "liquidity";
  /** Tokens that were paired (used to render stacked icons + symbol pair). */
  token0: { address: Address; symbol?: string };
  token1: { address: Address; symbol?: string };
  /**
   * Pre-formatted token amounts the user deposited. When provided, the
   * toast renders these instead of (or alongside) the LP balance because
   * "10 USDC + 3.16 ETH" reads way clearer than "5.6e-6 LP USDC/ETH".
   */
  amount0Formatted?: string;
  amount1Formatted?: string;
  /** Pre-formatted LP balance the user received, eg "1.234". Optional. */
  lpFormatted?: string;
  /** Optional "View pool" deep link that the toast routes to on click. */
  poolHref?: string;
  /** Optional block-explorer URL for the addLiquidity tx. */
  explorerUrl?: string;
}

export interface LiquidityRemovedToastPayload {
  kind: "liquidity-removed";
  /** Tokens that were redeemed (used to render stacked icons). */
  token0: { address: Address; symbol?: string };
  token1: { address: Address; symbol?: string };
  /** Pre-formatted amount of token0 that hit the user's wallet. */
  amount0Formatted: string;
  /** Pre-formatted amount of token1 that hit the user's wallet. */
  amount1Formatted: string;
  /** Optional pool detail link. */
  poolHref?: string;
  /** Optional block-explorer URL for the removeLiquidity tx. */
  explorerUrl?: string;
}

export interface ClaimFeesToastPayload {
  kind: "claim-fees";
  /** Position id (display label like "#1234"). */
  positionLabel: string;
  /** Tokens paired in the position (stacked icons). */
  token0: { address: Address; symbol?: string };
  token1: { address: Address; symbol?: string };
  /** Pre-formatted amount0 actually claimed; null when zero. */
  amount0Formatted?: string | null;
  /** Pre-formatted amount1 actually claimed; null when zero. */
  amount1Formatted?: string | null;
  /** Optional position detail link. */
  positionHref?: string;
  /** Optional block-explorer URL for the collect tx. */
  explorerUrl?: string;
}

export type ToastPayload =
    | SwapToastPayload
    | InfoToastPayload
    | LiquidityToastPayload
    | LiquidityRemovedToastPayload
    | ClaimFeesToastPayload;

const EVENT_NAME = "arc-toast";

export function pushToast(payload: ToastPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastPayload>(EVENT_NAME, { detail: payload }));
}

export function subscribeToToasts(handler: (payload: ToastPayload) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<ToastPayload>).detail);
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
