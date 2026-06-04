"use client";

import { ArrowRight, CheckCircle2, ExternalLink, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { subscribeToToasts, type ToastPayload } from "@/lib/toast";
import { TokenIcon } from "./TokenIcon";
import { AutoTokenIcon } from "./AutoTokenIcon";

interface ToastItem extends Object {
  id: string;
  payload: ToastPayload;
}

const DURATION_MS = 5000;

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    return subscribeToToasts((payload) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((prev) => [...prev, { id, payload }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, DURATION_MS);
    });
  }, []);

  const remove = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (!mounted) return null;

  return createPortal(
    <div className="pointer-events-none fixed bottom-6 right-6 z-[200] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} payload={t.payload} onClose={() => remove(t.id)} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ payload, onClose }: { payload: ToastPayload; onClose: () => void }) {
  if (payload.kind === "liquidity") {
    const symA = payload.token0.symbol ?? "?";
    const symB = payload.token1.symbol ?? "?";
    return (
      <div className="pointer-events-auto flex w-80 items-center gap-3 rounded-2xl border border-arc-success/40 bg-black/65 p-3 shadow-arc-card backdrop-blur-xl animate-in slide-in-from-right">
        {/* Stacked pair icons */}
        <div className="flex -space-x-2">
          <AutoTokenIcon address={payload.token0.address} symbol={symA} size={32} />
          <AutoTokenIcon address={payload.token1.address} symbol={symB} size={32} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs text-arc-text-muted">
            <CheckCircle2 className="h-3.5 w-3.5 text-arc-success" />
            <span>Liquidity added</span>
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-arc-text">
            {payload.lpFormatted} LP {symA}/{symB}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px]">
            {payload.poolHref && (
              <Link
                href={payload.poolHref}
                onClick={onClose}
                className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 hover:underline"
              >
                View pool <ArrowRight className="h-2.5 w-2.5" />
              </Link>
            )}
            {payload.explorerUrl && (
              <a
                href={payload.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-arc-text-faint hover:text-arc-text"
              >
                Tx <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
        </div>
        <button onClick={onClose} className="text-arc-text-faint hover:text-arc-text">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (payload.kind === "swap") {
    return (
      <div className="pointer-events-auto flex w-72 items-center gap-3 rounded-2xl border border-arc-gray/40 bg-black/60 p-3 shadow-arc-card backdrop-blur-xl animate-in slide-in-from-right">
        {payload.tokenImage ? (
          <TokenIcon symbol={payload.tokenSymbol} image={payload.tokenImage} size={36} />
        ) : (
          // Fall back to auto-resolving the logo from on-chain metadata when the
          // caller didn't pass a direct image (eg the swap card's toast).
          <AutoTokenIcon address={payload.tokenAddress} symbol={payload.tokenSymbol} size={36} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs text-arc-text-muted">
            <span>Confirmed</span>
            <CheckCircle2 className="h-3.5 w-3.5 text-arc-success" />
          </div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-arc-text">
            {payload.amountFormatted} {payload.tokenSymbol ?? "TOKEN"}
          </div>
          {payload.explorerUrl && (
            <a
              href={payload.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 hover:underline"
            >
              View mint tx <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
        </div>
        <button onClick={onClose} className="text-arc-text-faint hover:text-arc-text">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  const isError = payload.kind === "error";
  return (
    <div
      className={`pointer-events-auto flex w-72 items-center gap-3 rounded-2xl border p-3 shadow-arc-card backdrop-blur-xl ${
        isError
          ? "border-arc-danger/50 bg-arc-danger/10"
          : "border-arc-gray/40 bg-black/60"
      }`}
    >
      <div
        className={`flex h-9 w-9 items-center justify-center rounded-full ${
          isError ? "bg-arc-danger/15 text-arc-danger" : "bg-arc-primary/15 text-arc-primary"
        }`}
      >
        {isError ? <XCircle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-arc-text">{payload.title}</div>
        {payload.message && <div className="mt-0.5 text-xs text-arc-text-muted">{payload.message}</div>}
      </div>
      <button onClick={onClose} className="text-arc-text-faint hover:text-arc-text">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
