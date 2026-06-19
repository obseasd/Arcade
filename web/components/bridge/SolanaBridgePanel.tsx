"use client";

import { useCallback, useState } from "react";
import { ArrowDownUp } from "lucide-react";
import { useAccount } from "wagmi";
import type { EIP1193Provider } from "viem";
import {
  estimateKitBridge,
  executeKitBridge,
  getPhantom,
  isSolanaBridgeConfigured,
  type BridgeDirection,
} from "@/lib/fx/bridgeKit";

/**
 * Solana <-> Arc USDC bridge (SCAFFOLD) via Circle App Kit.
 *
 * Isolated from the audited EVM/CCTP BridgeCard: this only handles the
 * Solana leg. Renders null unless a Kit Key is configured. Marked beta —
 * not yet exercised in-browser.
 */

type Phase = "idle" | "quoting" | "bridging" | "done" | "error";

export function SolanaBridgePanel() {
  const { address: evmAddress, connector } = useAccount();
  const [solAddress, setSolAddress] = useState<string | null>(null);
  const [direction, setDirection] = useState<BridgeDirection>("arc-to-solana");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [quote, setQuote] = useState<string | null>(null);

  const evmIsSource = direction === "arc-to-solana";

  const getEvmProvider =
    useCallback(async (): Promise<EIP1193Provider | null> => {
      if (!connector?.getProvider) return null;
      try {
        return (await connector.getProvider()) as EIP1193Provider;
      } catch {
        return null;
      }
    }, [connector]);

  const connectPhantom = async () => {
    const sol = getPhantom();
    if (!sol) {
      setPhase("error");
      setMessage("Phantom wallet not found — install it to bridge to Solana.");
      return;
    }
    try {
      const res = await sol.connect();
      setSolAddress(res.publicKey.toString());
      setPhase("idle");
      setMessage("");
    } catch {
      setPhase("error");
      setMessage("Phantom connection rejected.");
    }
  };

  const buildOpts = async () => {
    const sol = getPhantom();
    const evmProvider = await getEvmProvider();
    if (!evmProvider || !evmAddress || !sol || !solAddress) return null;
    return {
      direction,
      evmProvider,
      evmAddress,
      solanaProvider: sol,
      solanaAddress: solAddress,
      amount,
    };
  };

  const onQuote = async () => {
    const opts = await buildOpts();
    if (!opts || !(Number(amount) > 0)) return;
    setPhase("quoting");
    setMessage("");
    try {
      const est = await estimateKitBridge(opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (est as any)?.estimatedOutput ?? (est as any)?.amount;
      setQuote(out ? String(out) : "ok");
      setPhase("idle");
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Quote failed");
    }
  };

  const onBridge = async () => {
    const opts = await buildOpts();
    if (!opts || !(Number(amount) > 0)) return;
    setPhase("bridging");
    setMessage("Confirm in your wallet(s)…");
    try {
      const res = await executeKitBridge(opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (res as any)?.state ?? "submitted";
      setPhase("done");
      setMessage(`Bridge ${String(state)}.`);
      setAmount("");
      setQuote(null);
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Bridge failed");
    }
  };

  if (!isSolanaBridgeConfigured()) return null;

  const busy = phase === "quoting" || phase === "bridging";
  const ready = !!evmAddress && !!solAddress && Number(amount) > 0;

  return (
    <div className="arc-card relative p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-arc-text">
          Solana bridge{" "}
          <span className="ml-1 rounded bg-arc-primary-soft px-1.5 py-0.5 align-middle text-[10px] text-arc-gray">
            beta
          </span>
        </h2>
        <span className="text-[11px] text-arc-gray">
          {evmIsSource ? "Arc → Solana" : "Solana → Arc"} · USDC
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-arc-gray">
          {evmIsSource ? "From Arc" : "To Arc"}:{" "}
          {evmAddress ? `${evmAddress.slice(0, 6)}…` : "connect EVM wallet"}
        </div>
        <button
          type="button"
          onClick={() => {
            setDirection(evmIsSource ? "solana-to-arc" : "arc-to-solana");
            setQuote(null);
          }}
          aria-label="Flip direction"
          className="rounded-lg border border-arc-border p-1.5 text-arc-gray transition-colors hover:text-arc-cta-hover"
        >
          <ArrowDownUp className="h-4 w-4" />
        </button>
        <div className="text-xs text-arc-gray">
          {evmIsSource ? "To Solana" : "From Solana"}:{" "}
          {solAddress ? (
            `${solAddress.slice(0, 6)}…`
          ) : (
            <button
              type="button"
              onClick={connectPhantom}
              className="text-arc-cta-hover underline"
            >
              connect Phantom
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-arc-border bg-arc-bg px-3 py-2">
        <div className="mb-1 text-[11px] text-arc-gray">Amount · USDC</div>
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "" || /^\d*\.?\d*$/.test(v)) {
              setAmount(v);
              setQuote(null);
            }
          }}
          className="w-full bg-transparent text-lg text-arc-text outline-none placeholder:text-arc-gray"
        />
      </div>

      {quote && (
        <p className="mt-2 text-xs text-arc-gray">Estimated: {quote}</p>
      )}
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

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onQuote}
          disabled={!ready || busy}
          className="flex-1 rounded-xl border border-arc-border py-2.5 text-sm font-semibold text-arc-text transition-colors hover:border-arc-cta-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === "quoting" ? "Quoting…" : "Quote"}
        </button>
        <button
          type="button"
          onClick={onBridge}
          disabled={!ready || busy}
          className="flex-1 rounded-xl bg-arc-cta py-2.5 text-sm font-semibold text-arc-bg transition-colors hover:bg-arc-cta-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === "bridging" ? "Bridging…" : "Bridge"}
        </button>
      </div>
    </div>
  );
}
