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
}

export interface InfoToastPayload {
  kind: "info" | "error";
  title: string;
  message?: string;
}

export type ToastPayload = SwapToastPayload | InfoToastPayload;

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
