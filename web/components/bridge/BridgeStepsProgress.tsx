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
  current: StepKey;
  /** Optional human-readable detail under the active step. */
  detail?: string;
}

const STEPS: { key: Exclude<StepKey, "idle">; label: string }[] = [
  { key: "burn", label: "Burn" },
  { key: "attest", label: "Attestation" },
  { key: "mint", label: "Mint" },
];

const DOT_SIZE = 32;
const DOT_CENTER = DOT_SIZE / 2;

export function BridgeStepsProgress({ current, detail }: Props) {
  if (current === "idle") return null;

  // Index of the active step; done = all three completed.
  const activeIndex =
    current === "done" ? STEPS.length : STEPS.findIndex((s) => s.key === current);

  return (
    <div className="rounded-2xl border border-arc-border bg-black/30 px-5 py-4">
      {/* Grid layout: one column per step. Dots + connector lines render on
          a top row, labels render directly below each dot. This keeps each
          dot perfectly centered above its label and gives the connector
          lines clean horizontal alignment between dot centers. */}
      <div
        className="relative grid"
        style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }}
      >
        {/* Connector lines layer - absolutely positioned over the grid so
            they don't push the dots around. One line per gap. */}
        <div className="pointer-events-none absolute left-0 right-0 flex h-8 items-center">
          {STEPS.slice(0, -1).map((_, i) => {
            // Line span: from the center of column i to the center of column i+1.
            const colWidthPct = 100 / STEPS.length;
            const leftPct = colWidthPct * (i + 0.5);
            const widthPct = colWidthPct;
            // The line stops just before the next dot so it doesn't underlap it.
            const isCompleted = i < activeIndex;
            return (
              <div
                key={i}
                className={cn(
                  "absolute h-px transition-colors",
                  isCompleted ? "bg-arc-success" : "bg-arc-border",
                )}
                style={{
                  left: `calc(${leftPct}% + ${DOT_CENTER + 2}px)`,
                  width: `calc(${widthPct}% - ${DOT_SIZE + 4}px)`,
                }}
              />
            );
          })}
        </div>

        {/* Dots */}
        {STEPS.map((step, i) => {
          const status: "done" | "active" | "pending" =
            i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
          return (
            <div key={step.key} className="relative flex flex-col items-center gap-2.5">
              <Dot status={status} />
              <span
                className={cn(
                  "text-center text-[10px] uppercase tracking-wider transition-colors",
                  status === "done"
                    ? "text-arc-success"
                    : status === "active"
                      ? "font-semibold text-arc-text"
                      : "text-arc-text-faint",
                )}
              >
                {step.label}
              </span>
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
      <div
        className="flex items-center justify-center rounded-full bg-arc-success/15 text-arc-success ring-2 ring-arc-success/40"
        style={{ width: DOT_SIZE, height: DOT_SIZE }}
      >
        <Check className="h-4 w-4" />
      </div>
    );
  }
  if (status === "active") {
    return (
      <div
        className="relative flex items-center justify-center rounded-full bg-arc-cta-hover/15 text-arc-cta-hover ring-2 ring-arc-cta-hover/60"
        style={{ width: DOT_SIZE, height: DOT_SIZE }}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {/* Soft halo on the active step so it's the clear focal point. */}
        <span
          className="pointer-events-none absolute -inset-1 rounded-full bg-arc-cta-hover/15 blur-sm"
          aria-hidden
        />
      </div>
    );
  }
  return (
    <div
      className="flex items-center justify-center rounded-full bg-arc-bg-elevated ring-2 ring-arc-border"
      style={{ width: DOT_SIZE, height: DOT_SIZE }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-arc-text-faint" />
    </div>
  );
}
