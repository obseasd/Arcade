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
import { cn } from "@/lib/utils";

interface Props {
  token: Address;
  /** 0 = PUMP, 1 = Arcade, 2 = Clanker V3 */
  mode?: number;
  /** Pool address for Clanker tokens (state.v2Pair on the launchpad). */
  pool?: Address;
}

/**
 * Candlestick + volume chart powered by TradingView lightweight-charts.
 * Reads trade events on-chain and aggregates into OHLC candles by timeframe.
 */
export function PriceChart({ token, mode, pool }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");

  const { candles, isLoading } = useTokenCandles({
    token,
    mode,
    pool,
    timeframe,
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
      rightPriceScale: { borderColor: "rgba(40, 60, 90, 0.5)" },
      timeScale: {
        borderColor: "rgba(40, 60, 90, 0.5)",
        timeVisible: true,
        secondsVisible: false,
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
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });

    volumeSeriesRef.current = chart.addHistogramSeries({
      color: "rgba(66, 114, 154, 0.4)",
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volumeSeriesRef.current.priceScale().applyOptions({
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

  // Push candles into the chart whenever the data changes.
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    const candleData: CandlestickData[] = candles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const volumeData: HistogramData[] = candles.map((c) => ({
      time: c.time as Time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(34, 197, 94, 0.4)" : "rgba(239, 68, 68, 0.4)",
    }));
    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volumeData);
    if (candles.length > 0 && chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [candles]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-1 text-xs">
        {(["5m", "1h", "1d"] as Timeframe[]).map((tf) => (
          <button
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
