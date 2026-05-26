"use client";

import { CheckCircle2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { subscribeToToasts, type ToastPayload } from "@/lib/toast";
import { TokenIcon } from "./TokenIcon";

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
  if (payload.kind === "swap") {
    return (
      <div className="pointer-events-auto flex w-72 items-center gap-3 rounded-2xl border border-arc-gray/40 bg-black/60 p-3 shadow-arc-card backdrop-blur-xl animate-in slide-in-from-right">
        <TokenIcon symbol={payload.tokenSymbol} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs text-arc-text-muted">
            <span>Swap confirmed</span>
            <CheckCircle2 className="h-3.5 w-3.5 text-arc-success" />
          </div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-arc-text">
            {payload.amountFormatted} {payload.tokenSymbol ?? "TOKEN"}
          </div>
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
