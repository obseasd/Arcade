"use client";

import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type TxState =
  | { status: "idle" }
  | { status: "pending"; message?: string }
  | { status: "success"; hash?: string; message?: string }
  | { status: "error"; message: string };

export function TxStatus({ state, className }: { state: TxState; className?: string }) {
  if (state.status === "idle") return null;

  const icon =
    state.status === "pending" ? (
      <Loader2 className="h-4 w-4 animate-spin text-arc-primary" />
    ) : state.status === "success" ? (
      <CheckCircle2 className="h-4 w-4 text-arc-success" />
    ) : (
      <XCircle className="h-4 w-4 text-arc-danger" />
    );

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        state.status === "pending" && "border-arc-border bg-arc-surface text-arc-text-muted",
        state.status === "success" && "border-arc-success/40 bg-arc-success/10 text-arc-success",
        state.status === "error" && "border-arc-danger/40 bg-arc-danger/10 text-arc-danger",
        className,
      )}
    >
      {icon}
      <span className="truncate">
        {state.message ??
          (state.status === "pending"
            ? "Transaction pending…"
            : state.status === "success"
              ? "Transaction confirmed"
              : "Transaction failed")}
      </span>
    </div>
  );
}
