"use client";

import { RotateCcw } from "lucide-react";
import type { SimulatorConfig } from "@/lib/lpSimulator/math";
import { poolFraction } from "@/lib/lpSimulator/math";
import { PRESETS, type PresetDef } from "@/lib/lpSimulator/presets";
import { cn } from "@/lib/utils";

interface Props {
  config: SimulatorConfig;
  presetId: string;
  onPreset: (preset: PresetDef) => void;
  onConfigChange: (next: SimulatorConfig) => void;
  onReset: () => void;
}

function fmtMcap(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function parseMcap(raw: string): number | undefined {
  const s = raw.trim().toUpperCase().replace(/[$,_\s]/g, "");
  if (!s) return undefined;
  const m = s.match(/^(\d*\.?\d+)([KMB])?$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return undefined;
  const mult = m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1;
  return n * mult;
}

export function SidebarPanel({ config, presetId, onPreset, onConfigChange, onReset }: Props) {
  const poolPct = poolFraction(config) * 100;

  return (
    <div className="space-y-4">
      <div className="arc-card p-5">
        <h3 className="mb-3 text-sm font-semibold">Quick Presets</h3>
        <div className="space-y-2">
          {PRESETS.map((p) => {
            const active = p.id === presetId;
            return (
              <button
                key={p.id}
                onClick={() => onPreset(p)}
                className={cn(
                  "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-arc-cta-hover bg-arc-cta-hover/15 ring-1 ring-inset ring-arc-cta-hover/40"
                    : "border-arc-border bg-black/30 hover:bg-black/40",
                )}
              >
                <div className="text-sm font-medium">{p.label}</div>
                <div className="mt-0.5 text-xs text-arc-text-muted">{p.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="arc-card p-5">
        <h3 className="mb-3 text-sm font-semibold">Starting Market Cap</h3>
        <label className="text-xs text-arc-text-muted">USD Value</label>
        <div className="mt-1 flex items-center gap-2 rounded-xl border border-arc-border bg-black/40 px-3 py-2.5">
          <span className="text-arc-text-faint">$</span>
          <input
            type="text"
            defaultValue={shortMcap(config.startingMcap)}
            key={config.startingMcap}
            onBlur={(e) => {
              const v = parseMcap(e.target.value);
              if (v && v > 0) onConfigChange({ ...config, startingMcap: v });
              else e.target.value = shortMcap(config.startingMcap);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="arc-input text-sm"
          />
        </div>
        <div className="mt-1.5 text-xs text-arc-text-faint">
          {fmtMcap(config.startingMcap)} initial pool valuation
        </div>
      </div>

      <div className="arc-card p-5">
        <h3 className="mb-3 text-sm font-semibold">Supply Allocations</h3>
        <div className="grid grid-cols-3 gap-2">
          <AllocInput
            label="Airdrop %"
            value={config.airdropPct * 100}
            onChange={(v) => onConfigChange({ ...config, airdropPct: clamp01(v / 100) })}
          />
          <AllocInput
            label="Vault %"
            value={config.vaultPct * 100}
            onChange={(v) => onConfigChange({ ...config, vaultPct: clamp01(v / 100) })}
          />
          <AllocInput
            label="Presale %"
            value={config.presalePct * 100}
            onChange={(v) => onConfigChange({ ...config, presalePct: clamp01(v / 100) })}
          />
        </div>
        <div className="mt-3 text-xs text-arc-text-muted">
          Pool: <span className={cn("font-medium", poolPct >= 50 ? "text-arc-success" : "text-amber-400")}>{poolPct.toFixed(0)}%</span>
        </div>
      </div>

      <button
        onClick={onReset}
        className="arc-button-secondary w-full px-3 py-2.5 text-sm"
      >
        <RotateCcw className="h-3.5 w-3.5" /> Reset All
      </button>
    </div>
  );
}

function AllocInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="text-xs text-arc-text-muted">{label}</label>
      <input
        type="number"
        min={0}
        max={100}
        step={1}
        value={Math.round(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-lg border border-arc-border bg-black/40 px-2.5 py-2 text-sm text-arc-text focus:border-arc-cta-hover focus:outline-none"
      />
    </div>
  );
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function shortMcap(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2).replace(/\.0+$/, "")}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2).replace(/\.0+$/, "")}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return Math.round(v).toString();
}
