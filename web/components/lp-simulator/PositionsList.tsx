"use client";

import { useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { PositionInput } from "@/lib/lpSimulator/math";
import { positionColor } from "@/lib/lpSimulator/colors";
import { cn, parseMcap } from "@/lib/utils";

interface Props {
  positions: PositionInput[];
  onChange: (next: PositionInput[]) => void;
}

function fmtMcap(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

// parseMcap lives in @/lib/utils now.

/** Filled-track gradient for the position % slider. */
function sliderFill(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  return `linear-gradient(to right, #15508f 0%, #2f7fd6 ${p}%, rgba(255,255,255,0.16) ${p}%, rgba(255,255,255,0.16) 100%)`;
}

export function PositionsList({ positions, onChange }: Props) {
  const total = positions.reduce((acc, p) => acc + p.pctOfPool * 100, 0);

  const update = useCallback(
    (i: number, patch: Partial<PositionInput>) => {
      onChange(positions.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
    },
    [positions, onChange],
  );

  const add = useCallback(() => {
    if (positions.length >= 10) return;
    const last = positions[positions.length - 1];
    const lower = last ? last.upperMcap : 30_000;
    const upper = lower * 10;
    onChange([...positions, { lowerMcap: lower, upperMcap: upper, pctOfPool: 0 }]);
  }, [positions, onChange]);

  const remove = useCallback(
    (i: number) => {
      if (positions.length <= 1) return;
      onChange(positions.filter((_, idx) => idx !== i));
    },
    [positions, onChange],
  );

  return (
    <div className="arc-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">LP Positions</h3>
        <div className="flex items-center gap-2">
          <span className={cn("text-xs font-medium", Math.abs(total - 100) < 0.5 ? "text-arc-success" : "text-amber-400")}>
            {total.toFixed(1)}%
          </span>
          <button type="button"
            onClick={add}
            className="rounded-md border border-arc-border bg-arc-surface-2 p-1.5 text-arc-text-muted hover:text-arc-text"
            aria-label="Add position"
            disabled={positions.length >= 10}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {positions.map((p, i) => (
          <div key={i} className="rounded-xl border border-arc-border bg-black/30 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: positionColor(i) }}
                  aria-hidden
                />
                <span className="font-medium text-arc-text">#{i + 1}</span>
                <span className="text-arc-text-muted">
                  {fmtMcap(p.lowerMcap)} <span className="text-arc-text-faint">→</span> {fmtMcap(p.upperMcap)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.5}
                  value={Math.round(p.pctOfPool * 1000) / 10}
                  onChange={(e) => update(i, { pctOfPool: Number(e.target.value) / 100 })}
                  className="arc-slider w-32"
                  style={{ background: sliderFill(p.pctOfPool * 100) }}
                />
                <span className="w-10 text-right text-xs font-medium">{(p.pctOfPool * 100).toFixed(0)}%</span>
                <button type="button"
                  onClick={() => remove(i)}
                  disabled={positions.length <= 1}
                  className="rounded-md p-1 text-arc-text-faint hover:text-arc-danger disabled:opacity-40"
                  aria-label="Remove position"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <McapInput
                value={p.lowerMcap}
                onCommit={(v) => update(i, { lowerMcap: v })}
              />
              <McapInput
                value={p.upperMcap}
                onCommit={(v) => update(i, { upperMcap: v })}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function McapInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  return (
    <input
      type="text"
      defaultValue={fmtShort(value)}
      key={value}
      onBlur={(e) => {
        const parsed = parseMcap(e.target.value);
        if (parsed !== undefined && parsed > 0) onCommit(parsed);
        else e.target.value = fmtShort(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="rounded-lg border border-arc-border bg-black/40 px-3 py-2 text-xs text-arc-text focus:border-arc-cta-hover focus:outline-none"
    />
  );
}

function fmtShort(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2).replace(/\.0+$/, "")}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2).replace(/\.0+$/, "")}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return Math.round(v).toString();
}
