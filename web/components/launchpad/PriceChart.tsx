"use client";

import { useEffect, useRef, useState } from "react";
import { Address } from "viem";
import {
  createChart,
  CrosshairMode,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useTokenCandles, type Timeframe } from "@/lib/hooks/useTokenCandles";
import { LAUNCHPAD_TOTAL_SUPPLY } from "@/lib/constants";
import { cn } from "@/lib/utils";

const SUPPLY = Number(LAUNCHPAD_TOTAL_SUPPLY); // 1e9, all launches have 1B supply

interface Props {
  token: Address;
  /** 0 = PUMP, 1 = Arcade, 2 = Clanker V3 */
  mode?: number;
  /** Pool address for Clanker tokens (state.v2Pair on the launchpad). */
  pool?: Address;
  /** Goldsky source override ("v4" for ArcadeHook tokens). */
  source?: string;
}

/**
 * Candlestick + volume chart powered by TradingView lightweight-charts.
 * Reads trade events on-chain and aggregates into OHLC candles by timeframe.
 */
export function PriceChart({ token, mode, pool, source }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [metric, setMetric] = useState<"price" | "mcap">("price");

  const { candles, isLoading } = useTokenCandles({
    token,
    mode,
    pool,
    timeframe,
    source,
  });

  // Mount the chart once, then update its data when candles change.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 320,
      layout: {
        background: { color: "transparent" },
        textColor: "#92A8C2",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(40, 60, 90, 0.25)" },
        horzLines: { color: "rgba(40, 60, 90, 0.25)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "rgba(40, 60, 90, 0.5)",
        autoScale: true,
        // Generous vertical breathing room. A wider visible range also makes
        // lightweight-charts add more gridlines automatically — the user
        // perceives the chart as "less zoomed in".
        scaleMargins: { top: 0.15, bottom: 0.30 },
      },
      timeScale: {
        borderColor: "rgba(40, 60, 90, 0.5)",
        timeVisible: true,
        secondsVisible: false,
        // Wider bar spacing + right offset so candles feel less cramped and
        // there's room on the right for upcoming candles, like TradingView.
        barSpacing: 12,
        rightOffset: 10,
      },
    });
    chartRef.current = chart;

    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      // High precision for micro-cap price mode; coarser for marketcap mode.
      priceFormat: { type: "price", precision: 12, minMove: 0.000000000001 },
    });

    volumeSeriesRef.current = chart.addHistogramSeries({
      color: "rgba(66, 114, 154, 0.4)",
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volumeSeriesRef.current.priceScale().applyOptions({
      // Volume bars occupy the bottom 15% of the chart, separate from candles
      // and below the candle area's bottom margin (0.30) for clear separation.
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    const ro = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Push candles into the chart whenever data or metric mode changes.
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    const scale = metric === "mcap" ? SUPPLY : 1;
    const candleData: CandlestickData[] = candles.map((c) => ({
      time: c.time as Time,
      open: c.open * scale,
      high: c.high * scale,
      low: c.low * scale,
      close: c.close * scale,
    }));
    const volumeData: HistogramData[] = candles.map((c) => ({
      time: c.time as Time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(34, 197, 94, 0.4)" : "rgba(239, 68, 68, 0.4)",
    }));
    // Switch axis precision based on metric (micro-cap prices vs $ market caps).
    candleSeriesRef.current.applyOptions({
      priceFormat:
        metric === "mcap"
          ? { type: "price", precision: 0, minMove: 1 }
          : { type: "price", precision: 12, minMove: 0.000000000001 },
    });
    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volumeData);
    if (candles.length > 0 && chartRef.current) {
      // Bounce autoScale via applyOptions. lightweight-charts v4 doesn't have
      // a setAutoScale method, but toggling the option forces a recompute of
      // the price range — needed when only the data values change (price ↔
      // market cap switch).
      const ps = chartRef.current.priceScale("right");
      ps.applyOptions({ autoScale: false });
      ps.applyOptions({ autoScale: true });
      // Scroll to the most recent candle so the rightOffset shows empty space
      // on the right (TradingView style). We avoid fitContent() because it
      // would override our barSpacing/rightOffset to cram all bars into the
      // chart width.
      chartRef.current.timeScale().scrollToRealTime();
    }
  }, [candles, metric]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-1 text-xs">
        <div className="flex items-center gap-1 rounded-lg border border-arc-border bg-arc-bg-elevated p-0.5">
          {(["price", "mcap"] as const).map((m) => (
            <button type="button"
              key={m}
              onClick={() => setMetric(m)}
              className={cn(
                "rounded-md px-2 py-1 transition-colors",
                metric === m
                  ? "bg-arc-primary text-white"
                  : "text-arc-text-muted hover:text-arc-text",
              )}
            >
              {m === "price" ? "Price" : "Market cap"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {(["1s", "1m", "5m", "1h", "1d"] as Timeframe[]).map((tf) => (
            <button type="button"
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={cn(
                "rounded-md px-2 py-1 transition-colors",
                timeframe === tf
                  ? "bg-arc-primary text-white"
                  : "text-arc-text-muted hover:bg-arc-surface-2 hover:text-arc-text",
              )}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="relative h-80 w-full">
        {isLoading && candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-arc-text-faint">
            Loading chart…
          </div>
        )}
        {!isLoading && candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-arc-text-muted">
            No trades yet, be the first.
          </div>
        )}
      </div>
    </div>
  );
}
