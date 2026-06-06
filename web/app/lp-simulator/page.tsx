"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { SimulatorConfig } from "@/lib/lpSimulator/math";
import { DEFAULT_PRESET_ID, getPreset, type PresetDef } from "@/lib/lpSimulator/presets";
import { positionColor } from "@/lib/lpSimulator/colors";
import { PositionsList } from "@/components/lp-simulator/PositionsList";
import { SidebarPanel } from "@/components/lp-simulator/SidebarPanel";
import { SimulationPanel } from "@/components/lp-simulator/SimulationPanel";
import { cn } from "@/lib/utils";

// LiquidityChart pulls recharts (~80 KB gzipped). Dynamic-import so it's
// fetched only when the page mounts, not eagerly in the route bundle.
// ssr: false because recharts uses ResizeObserver / DOM APIs that don't
// exist server-side. Skeleton placeholder keeps the layout stable
// during the lazy fetch.
const LiquidityChart = dynamic(
  () =>
    import("@/components/lp-simulator/LiquidityChart").then((m) => ({
      default: m.LiquidityChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="h-full min-h-[260px] w-full animate-pulse rounded-xl border border-arc-border bg-arc-bg-elevated/50" />
    ),
  },
);

const DEFAULT_PRESET = getPreset(DEFAULT_PRESET_ID)!;

type MobileTab = "setup" | "chart" | "simulate";

export default function LpSimulatorPage() {
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET.id);
  const [config, setConfig] = useState<SimulatorConfig>(DEFAULT_PRESET.config);
  // On lg+ all three panels render side-by-side; below lg we use a tab
  // strip so the user only sees one panel at a time instead of scrolling
  // 2000+ px through Setup → Chart → Simulate.
  const [mobileTab, setMobileTab] = useState<MobileTab>("chart");

  const onPreset = (p: PresetDef) => {
    setPresetId(p.id);
    setConfig(p.config);
  };

  const onReset = () => {
    setPresetId(DEFAULT_PRESET.id);
    setConfig(DEFAULT_PRESET.config);
  };

  const totalPct = useMemo(
    () => config.positions.reduce((acc, p) => acc + p.pctOfPool * 100, 0),
    [config.positions],
  );

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">LP Position Simulator</h1>
        <p className="mt-1 text-sm text-arc-text-muted">
          Model USDC-paired Clanker V3 configurations and simulate how buys move
          the price.
        </p>
      </header>

      {/* Mobile-only tab strip. Hidden on lg+ where the 3 panels fit
          side-by-side. Order matches the natural flow: configure → see the
          curve → run scenarios. */}
      <div className="mb-4 flex gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1 lg:hidden">
        {(["setup", "chart", "simulate"] as MobileTab[]).map((t) => (
          <button type="button"
            key={t}
            onClick={() => setMobileTab(t)}
            className={cn(
              "flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              mobileTab === t
                ? "bg-arc-primary text-white"
                : "text-arc-text-muted hover:bg-arc-surface hover:text-arc-text",
            )}
          >
            {t === "setup" ? "Setup" : t === "chart" ? "Chart" : "Simulate"}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        <div className={cn(mobileTab === "setup" ? "block" : "hidden", "lg:block")}>
          <SidebarPanel
            config={config}
            presetId={presetId}
            onPreset={onPreset}
            onConfigChange={setConfig}
            onReset={onReset}
          />
        </div>

        <div className={cn("space-y-4", mobileTab === "chart" ? "block" : "hidden", "lg:block")}>
          <div className="arc-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Liquidity Distribution</h3>
              <div className="text-[11px] text-arc-text-muted">
                {config.positions.length} position{config.positions.length === 1 ? "" : "s"}
                {Math.abs(totalPct - 100) > 0.5 && (
                  <span className="ml-2 text-amber-400">
                    ({totalPct.toFixed(0)}% allocated)
                  </span>
                )}
              </div>
            </div>
            <LiquidityChart config={config} />
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
              <LegendItem color="#92A8C2" label="X: Market Cap" />
              <LegendItem color="#92A8C2" label="L: Supply in Pool %" />
              <LegendItem color="#f97316" label="R: Cumulative Sold %" />
              {config.positions.map((p, i) => (
                <LegendItem
                  key={`legend-pos-${i}`}
                  color={positionColor(i)}
                  label={`Position ${i + 1} (${(p.pctOfPool * 100).toFixed(0)}%)`}
                />
              ))}
            </div>
          </div>

          <PositionsList
            positions={config.positions}
            onChange={(positions) => setConfig({ ...config, positions })}
          />

          <ExportConfig config={config} />
        </div>

        <div className={cn(mobileTab === "simulate" ? "block" : "hidden", "lg:block")}>
          <SimulationPanel config={config} quotePriceUsd={1} quoteSymbol="USDC" />
        </div>
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-arc-text-muted">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

function ExportConfig({ config }: { config: SimulatorConfig }) {
  const [open, setOpen] = useState(false);
  const startingTick = Math.floor(
    Math.log(config.startingMcap / config.totalSupply) / Math.log(1.0001),
  );
  const json = JSON.stringify(
    {
      pair: "USDC",
      totalSupply: config.totalSupply,
      startingMcap: config.startingMcap,
      allocations: {
        airdropPct: config.airdropPct,
        vaultPct: config.vaultPct,
        presalePct: config.presalePct,
      },
      feeBps: config.feeBps,
      positions: config.positions.map((p) => ({
        lowerTick: Math.floor(Math.log(p.lowerMcap / config.totalSupply) / Math.log(1.0001)),
        upperTick: Math.floor(Math.log(p.upperMcap / config.totalSupply) / Math.log(1.0001)),
        pctOfPool: p.pctOfPool,
      })),
    },
    null,
    2,
  );

  return (
    <div className="arc-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Configuration Reference</h3>
        <button type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-arc-border bg-arc-surface-2 px-2.5 py-1 text-xs text-arc-text-muted hover:text-arc-text"
        >
          {open ? "Hide JSON" : "Show JSON"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-y-1.5 text-xs">
        <span className="text-arc-text-muted">Starting tick</span>
        <span className="text-right font-mono">{startingTick.toLocaleString()}</span>
        <span className="text-arc-text-muted">Positions</span>
        <span className="text-right">{config.positions.length}</span>
        <span className="text-arc-text-muted">Fee tier</span>
        <span className="text-right">{config.feeBps / 100}%</span>
        <span className="text-arc-text-muted">Tick spacing</span>
        <span className="text-right">200</span>
      </div>
      {open && (
        <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-arc-border bg-black/60 p-3 text-[10px] leading-relaxed">
          {json}
        </pre>
      )}
      <button type="button"
        onClick={() => navigator.clipboard?.writeText(json).catch(() => {})}
        className="mt-3 text-xs text-arc-cta-hover hover:underline"
      >
        Copy JSON to clipboard
      </button>
    </div>
  );
}
