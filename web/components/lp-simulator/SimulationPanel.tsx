"use client";

import { useMemo, useState } from "react";
import { Plus, Zap, TrendingUp, DollarSign, Info, RotateCcw } from "lucide-react";
import { buildPool, simulateBuy, type SimulatorConfig } from "@/lib/lpSimulator/math";
import { cn } from "@/lib/utils";

interface Props {
  config: SimulatorConfig;
  /** Price of the quote token in USD (1 for USDC). */
  quotePriceUsd: number;
  quoteSymbol: string;
}

const QUICK_BUYS = [100, 500, 1_000, 5_000, 10_000, 50_000];

/** Clanker V3 locker default split: creator gets 80%, platform 20%. */
const CREATOR_SHARE_BPS = 8_000;
const PLATFORM_SHARE_BPS = 10_000 - CREATOR_SHARE_BPS;

function fmtMcap(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtNum(v: number, dp = 4): string {
  if (!isFinite(v)) return "-";
  if (v >= 1e6) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function SimulationPanel({ config, quotePriceUsd, quoteSymbol }: Props) {
  const [buys, setBuys] = useState<number[]>([]);
  const [custom, setCustom] = useState("");
  const [feeBps, setFeeBps] = useState(config.feeBps);

  const result = useMemo(() => {
    let state = buildPool(config);
    let totalTokens = 0;
    let totalQuote = 0;
    let totalVolumeUsd = 0;
    let totalFeesQuote = 0;
    let lastClamped = false;
    for (const amount of buys) {
      const r = simulateBuy(state, amount, feeBps);
      totalTokens += r.tokensOut;
      totalQuote += r.quoteUsed;
      totalVolumeUsd += r.quoteUsed * quotePriceUsd;
      totalFeesQuote += r.feePaid;
      lastClamped = r.clamped;
      state = r.newState;
    }
    const currentPrice = state.sqrtPrice * state.sqrtPrice * quotePriceUsd;
    const currentMcap = currentPrice * config.totalSupply;
    return {
      totalTokens,
      totalQuote,
      totalVolumeUsd,
      totalFeesQuote,
      currentMcap,
      lastClamped,
    };
  }, [buys, config, quotePriceUsd, feeBps]);

  // Total LP fees in USD, split by recipient.
  const lpFeesUsd = result.totalFeesQuote * quotePriceUsd;
  const creatorFeesUsd = (lpFeesUsd * CREATOR_SHARE_BPS) / 10_000;
  const platformFeesUsd = (lpFeesUsd * PLATFORM_SHARE_BPS) / 10_000;
  const creatorFeesQuote = (result.totalFeesQuote * CREATOR_SHARE_BPS) / 10_000;

  const addBuy = (amount: number) => {
    if (amount > 0) setBuys((b) => [...b, amount]);
  };

  const reset = () => setBuys([]);

  return (
    <div className="space-y-4">
      <div className="arc-card p-5">
        <div className="mb-3 flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold">Simulate Buys</h3>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {QUICK_BUYS.map((amount) => (
            <button type="button"
              key={amount}
              onClick={() => addBuy(amount / quotePriceUsd)}
              className="rounded-lg border border-arc-border bg-black/40 px-2 py-2 text-xs font-medium text-arc-text hover:border-arc-cta-hover hover:bg-arc-cta/10"
            >
              +${shortNum(amount)}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            placeholder={`Amount in ${quoteSymbol}`}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="flex-1 rounded-lg border border-arc-border bg-black/40 px-3 py-2 text-xs text-arc-text focus:border-arc-cta-hover focus:outline-none"
            aria-label="Custom buy amount"
          />
          <button type="button"
            onClick={() => {
              const n = Number(custom);
              if (n > 0) {
                addBuy(n);
                setCustom("");
              }
            }}
            disabled={!custom || Number(custom) <= 0}
            className="arc-button-primary px-3 py-2 text-xs"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {buys.length > 0 && (
          <button type="button"
            onClick={reset}
            className="mt-3 flex items-center gap-1.5 text-xs text-arc-text-muted hover:text-arc-text"
          >
            <RotateCcw className="h-3 w-3" /> Reset {buys.length} buy{buys.length === 1 ? "" : "s"}
          </button>
        )}
      </div>

      <div className="arc-card p-5">
        <div className="mb-3 flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-purple-400" />
          <h3 className="text-sm font-semibold">Simulation Results</h3>
        </div>
        <div className="space-y-2.5 text-xs">
          <Row
            label={`Total ${quoteSymbol} bought`}
            value={`${fmtNum(result.totalQuote, 4)} ${quoteSymbol}`}
            bold
          />
          <Row label="USD value" value={`$${fmtNum(result.totalVolumeUsd, 0)}`} muted />
          <div className="my-2 border-t border-arc-border/60" />
          <Row label="Starting mcap" value={fmtMcap(config.startingMcap)} muted />
          <Row
            label="Current mcap"
            value={fmtMcap(result.currentMcap)}
            bold
            highlight={result.currentMcap > config.startingMcap}
          />
          {result.totalTokens > 0 && (
            <Row label="Tokens received" value={fmtNum(result.totalTokens, 0)} muted />
          )}
          {result.lastClamped && (
            <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
              Last buy clamped: top of liquidity reached.
            </div>
          )}
        </div>
      </div>

      <div className="arc-card p-5">
        <div className="mb-3 flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-arc-success" />
          <h3 className="text-sm font-semibold">Creator Fee Projection</h3>
        </div>
        <div className="mb-3">
          <label className="text-xs text-arc-text-muted">Pool fee tier</label>
          <div className="mt-1 grid grid-cols-3 gap-1.5">
            {[100, 200, 300].map((b) => (
              <button type="button"
                key={b}
                onClick={() => setFeeBps(b)}
                className={cn(
                  "rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                  feeBps === b
                    ? "border-arc-cta-hover bg-arc-cta-hover/15 text-white"
                    : "border-arc-border bg-black/30 text-arc-text-muted hover:text-arc-text",
                )}
              >
                {b / 100}%
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2 text-xs">
          <Row label="Swap volume" value={`$${fmtNum(result.totalVolumeUsd, 0)}`} muted />
          <Row label="Pool fee tier" value={`${feeBps / 100}%`} muted />
          <Row label="Total LP fees" value={`$${fmtNum(lpFeesUsd, 2)}`} muted />
          <div className="my-2 border-t border-arc-border/60" />
          <Row
            label="Platform (20%)"
            value={`-$${fmtNum(platformFeesUsd, 2)}`}
            muted
          />
          <Row
            label="Your share (80%)"
            value={`$${fmtNum(creatorFeesUsd, 2)}`}
            bold
            highlight={creatorFeesUsd > 0}
          />
          <Row label={`In ${quoteSymbol}`} value={fmtNum(creatorFeesQuote, 6)} muted />
        </div>
        {result.totalVolumeUsd === 0 && (
          <div className="mt-3 text-[11px] italic text-arc-text-faint">
            Add simulated buys above to see projected fees.
          </div>
        )}
      </div>

      <div className="arc-card border-arc-cta-hover/30 bg-arc-cta-hover/5 p-4 text-xs text-arc-text-muted">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-arc-text">
          <Info className="h-3.5 w-3.5 text-arc-cta-hover" /> About
        </div>
        Models how buys move through the LP positions. Each buy pays the pool
        fee to the LP first, then the rest swaps through concentrated-liquidity
        positions. Of every LP fee collected, creators receive 80% and Arcade
        keeps 20% (Clanker V3 split).
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
  highlight,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn("text-arc-text-muted", muted && "text-arc-text-faint")}>{label}</span>
      <span
        className={cn(
          bold && "font-semibold",
          highlight ? "text-arc-success" : "text-arc-text",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function shortNum(v: number): string {
  if (v >= 1e6) return `${v / 1e6}M`;
  if (v >= 1e3) return `${v / 1e3}K`;
  return v.toString();
}
