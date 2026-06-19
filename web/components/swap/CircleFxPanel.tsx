"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownUp } from "lucide-react";
import { useAccount } from "wagmi";
import type { EIP1193Provider } from "viem";
import {
  estimateFxSwap,
  executeFxSwap,
  isFxConfigured,
  type FxToken,
} from "@/lib/fx/appKit";

/**
 * Circle FX panel — native USDC <-> EURC settlement via Circle App Kit.
 *
 * Self-contained and fully isolated from the audited SwapCard / router
 * aggregator: it owns its own token direction + amount + quote + execute.
 * Renders only when a Kit Key is configured (isFxConfigured()), so with
 * the key absent this component is a no-op and the swap page is unchanged.
 *
 * Why a dedicated widget rather than a route in the comparator: App Kit
 * quotes are async service calls (not synchronous on-chain reads), and
 * EURC<->USDC is a narrow pair, so a small FX widget beats threading a
 * black-box async route into the on-chain route scoring.
 */

const FLAG_BY_TOKEN: Record<FxToken, string> = { USDC: "$", EURC: "€" };

type Phase = "idle" | "quoting" | "swapping" | "done" | "error";

export function CircleFxPanel() {
  const { address, connector } = useAccount();
  const [tokenIn, setTokenIn] = useState<FxToken>("USDC");
  const tokenOut: FxToken = tokenIn === "USDC" ? "EURC" : "USDC";
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");

  const flip = () => {
    setTokenIn(tokenOut);
    setQuote(null);
  };

  const getProvider = useCallback(async (): Promise<EIP1193Provider | null> => {
    if (!connector?.getProvider) return null;
    try {
      return (await connector.getProvider()) as EIP1193Provider;
    } catch {
      return null;
    }
  }, [connector]);

  // Debounced quote. Estimate is read-only (no signature) so it can run on
  // every settled keystroke without prompting the wallet.
  useEffect(() => {
    const n = Number(amount);
    if (!address || !amount || !(n > 0)) {
      setQuote(null);
      if (phase === "quoting") setPhase("idle");
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const provider = await getProvider();
      if (!provider || cancelled) return;
      setPhase("quoting");
      setMessage("");
      try {
        const est = await estimateFxSwap({
          provider,
          address,
          tokenIn,
          tokenOut,
          amountIn: amount,
          slippageBps: 50,
        });
        if (cancelled) return;
        // SwapEstimate.estimatedOutput is a human-readable decimal string.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = (est as any)?.estimatedOutput ?? (est as any)?.amountOut;
        setQuote(typeof out === "string" ? out : out ? String(out) : null);
        setPhase("idle");
      } catch (err) {
        if (cancelled) return;
        setQuote(null);
        setPhase("error");
        setMessage(err instanceof Error ? err.message : "Quote failed");
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, tokenIn, address]);

  const onSwap = async () => {
    const n = Number(amount);
    if (!address || !(n > 0)) return;
    const provider = await getProvider();
    if (!provider) {
      setPhase("error");
      setMessage("Wallet provider unavailable");
      return;
    }
    setPhase("swapping");
    setMessage("Confirm in your wallet…");
    try {
      const res = await executeFxSwap({
        provider,
        address,
        tokenIn,
        tokenOut,
        amountIn: amount,
        slippageBps: 50,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hash = (res as any)?.txHash ?? (res as any)?.hash;
      setPhase("done");
      setMessage(hash ? `Swapped. Tx ${String(hash).slice(0, 10)}…` : "Swapped.");
      setAmount("");
      setQuote(null);
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Swap failed");
    }
  };

  if (!isFxConfigured()) return null;

  const busy = phase === "quoting" || phase === "swapping";

  return (
    <div className="mt-4 rounded-2xl border border-arc-border bg-arc-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-display text-sm font-semibold text-arc-text">
          Circle FX
        </span>
        <span className="text-[11px] text-arc-gray">
          {tokenIn} → {tokenOut} · native rate · ~0.05% fee
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 rounded-xl border border-arc-border bg-arc-bg px-3 py-2">
          <div className="mb-1 text-[11px] text-arc-gray">
            You pay · {FLAG_BY_TOKEN[tokenIn]} {tokenIn}
          </div>
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d*\.?\d*$/.test(v)) setAmount(v);
            }}
            className="w-full bg-transparent text-lg text-arc-text outline-none placeholder:text-arc-gray"
          />
        </div>
        <button
          type="button"
          onClick={flip}
          aria-label="Flip direction"
          className="rounded-lg border border-arc-border p-2 text-arc-gray transition-colors hover:text-arc-cta-hover"
        >
          <ArrowDownUp className="h-4 w-4" />
        </button>
        <div className="flex-1 rounded-xl border border-arc-border bg-arc-bg px-3 py-2">
          <div className="mb-1 text-[11px] text-arc-gray">
            You receive · {FLAG_BY_TOKEN[tokenOut]} {tokenOut}
          </div>
          <div className="text-lg text-arc-text">
            {phase === "quoting" ? (
              <span className="animate-pulse text-arc-gray">…</span>
            ) : (
              quote ?? <span className="text-arc-gray">0.00</span>
            )}
          </div>
        </div>
      </div>

      {message && (
        <p
          className={
            "mt-2 text-xs " +
            (phase === "error" ? "text-red-400" : "text-arc-gray")
          }
        >
          {message}
        </p>
      )}

      <button
        type="button"
        onClick={onSwap}
        disabled={!address || !(Number(amount) > 0) || busy}
        className="mt-3 w-full rounded-xl bg-arc-cta py-2.5 text-sm font-semibold text-arc-bg transition-colors hover:bg-arc-cta-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {!address
          ? "Connect wallet"
          : phase === "swapping"
            ? "Swapping…"
            : `Swap ${tokenIn} → ${tokenOut} via Circle FX`}
      </button>
    </div>
  );
}
