"use client";

import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Visual stepper for the CCTP burn → attest → mint flow. Replaces a single
 * generic loader with explicit progress dots so users on slow source chains
 * (Eth Sepolia takes ~15-20 min for attestation) can see where they are.
 */
export type StepKey = "burn" | "attest" | "mint" | "done" | "idle";

interface Props {
  /** Current step. */
  current: StepKey;
  /** Optional human-readable detail under the active step (eg "Waiting for
   *  attestation… 3m elapsed"). */
  detail?: string;
}

const STEPS: { key: Exclude<StepKey, "idle">; label: string }[] = [
  { key: "burn", label: "Burn on source" },
  { key: "attest", label: "Circle attestation" },
  { key: "mint", label: "Mint on destination" },
];

export function BridgeStepsProgress({ current, detail }: Props) {
  if (current === "idle") return null;

  // Index of the active step; done = all three completed.
  const activeIndex = current === "done" ? STEPS.length : STEPS.findIndex((s) => s.key === current);

  return (
    <div className="rounded-2xl border border-arc-border bg-black/30 p-4">
      <div className="mb-2 flex items-center justify-between">
        {STEPS.map((step, i) => {
          const status: "done" | "active" | "pending" =
            i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
          return (
            <div key={step.key} className="flex flex-1 items-center">
              <Dot status={status} />
              {i < STEPS.length - 1 && (
                <div
                  className={cn(
                    "h-px flex-1 transition-colors",
                    status === "done" ? "bg-arc-success" : "bg-arc-border",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wider">
        {STEPS.map((step, i) => {
          const isActive = i === activeIndex;
          const isDone = i < activeIndex;
          return (
            <div
              key={step.key}
              className={cn(
                "text-center transition-colors",
                isDone
                  ? "text-arc-success"
                  : isActive
                    ? "font-semibold text-arc-text"
                    : "text-arc-text-faint",
              )}
            >
              {step.label}
            </div>
          );
        })}
      </div>
      {detail && (
        <div className="mt-3 text-center text-xs text-arc-text-muted">{detail}</div>
      )}
    </div>
  );
}

function Dot({ status }: { status: "done" | "active" | "pending" }) {
  if (status === "done") {
    return (
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-arc-success/15 text-arc-success ring-1 ring-arc-success/40">
        <Check className="h-3.5 w-3.5" />
      </div>
    );
  }
  if (status === "active") {
    return (
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-arc-cta-hover/15 text-arc-cta-hover ring-1 ring-arc-cta-hover/50">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-arc-bg-elevated ring-1 ring-arc-border">
      <span className="h-1.5 w-1.5 rounded-full bg-arc-text-faint" />
    </div>
  );
}
