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
  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [metric, setMetric] = useState<"price" | "mcap">("price");
  // Log scale by default for the curve's micro-price range. A 10-USDC
  // buy on a 5K-USDC virtual reserve moves price by ~0.4% and a 50-USDC
  // buy by ~2% - on a linear scale the 50-USDC candle's autoScale
  // expands the Y range enough that the 10-USDC body falls below pixel
  // resolution. Log keeps equal-percentage moves at equal screen
  // heights, matching how the user perceives "this trade was 5x bigger
  // than the previous one". User can flip back to linear via the
  // toggle next to the timeframe pills.
  const [logScale, setLogScale] = useState<boolean>(true);

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
    // Force candle color from the trade side when close == open exactly.
    // Bonding-curve trades of $1-$10 against a $10M virtual reserve round
    // through Q64.64 division to identical post-trade prices, so a buy +
    // sell pair on a tiny token look like green dojis everywhere (no
    // body, default up color). Coloring small buys green and small sells
    // red regardless of the price tie matches what the user expects to
    // see in transactions tab. When close != open we trust the price
    // direction and let lightweight-charts use the default up/down
    // palette - we only override the doji case.
    const candleData: CandlestickData[] = candles.map((c) => {
      const isDoji = c.open === c.close;
      const sideColor =
        c.lastTradeIsBuy === true
          ? "#22c55e"
          : c.lastTradeIsBuy === false
            ? "#ef4444"
            : undefined;
      return {
        time: c.time as Time,
        open: c.open * scale,
        high: c.high * scale,
        low: c.low * scale,
        close: c.close * scale,
        ...(isDoji && sideColor
          ? {
              color: sideColor,
              borderColor: sideColor,
              wickColor: sideColor,
            }
          : {}),
      };
    });
    const volumeData: HistogramData[] = candles.map((c) => ({
      time: c.time as Time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(34, 197, 94, 0.4)" : "rgba(239, 68, 68, 0.4)",
    }));
    // Auto-pick precision from the actual data range. A fixed precision
    // of 12 made micro-cap prices (5e-6 USDC/token) read fine but a
    // freshly-graduated token at 0.01 USDC/token displayed as
    // 0.010000000000 with 9 trailing zeros. Market cap mode keeps 0
    // precision (whole dollars). Price mode picks the lowest precision
    // that resolves to a non-zero leading digit on the maximum
    // observed value - capped at 12 for the curve's nano-prices.
    const maxAbs = candleData.reduce(
      (m, c) => Math.max(m, Math.abs(c.high), Math.abs(c.low)),
      0,
    );
    const pricePrecision =
      maxAbs === 0
        ? 6
        : Math.min(12, Math.max(2, Math.ceil(-Math.log10(maxAbs)) + 4));
    const priceMinMove = Math.pow(10, -pricePrecision);
    candleSeriesRef.current.applyOptions({
      priceFormat:
        metric === "mcap"
          ? { type: "price", precision: 0, minMove: 1 }
          : { type: "price", precision: pricePrecision, minMove: priceMinMove },
    });
    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volumeData);
    if (candles.length > 0 && chartRef.current) {
      // Bounce autoScale via applyOptions. lightweight-charts v4 doesn't have
      // a setAutoScale method, but toggling the option forces a recompute of
      // the price range — needed when only the data values change (price ↔
      // market cap switch).
      const ps = chartRef.current.priceScale("right");
      // Push scale mode in the same applyOptions sweep. lightweight-charts'
      // PriceScaleMode enum: 0 = Normal, 1 = Logarithmic, 2 = Percentage,
      // 3 = IndexedTo100. Log keeps equal-percentage moves at equal pixel
      // heights, which is what users expect on a micro-price curve where a
      // 50-USDC buy and a 10-USDC buy both deserve visible bodies.
      ps.applyOptions({ mode: logScale ? 1 : 0, autoScale: false });
      ps.applyOptions({ autoScale: true });
      // With only 1-2 candles, scrollToRealTime + rightOffset 10 can park
      // the lone candle off-screen left while the right edge shows empty
      // bars (the "1m chart looks blank after fresh trades" symptom).
      // fitContent on small datasets gives the user something to look at;
      // bigger histories keep the TradingView-style right-offset.
      if (candles.length <= 3) {
        chartRef.current.timeScale().fitContent();
      } else {
        chartRef.current.timeScale().scrollToRealTime();
      }
    }
  }, [candles, metric, logScale]);

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
        <div className="flex items-center gap-2">
          {/* Linear / Log scale toggle. Log is the default on a curve
              because equal-% moves should read as equal pixel heights,
              but linear is sometimes more readable post-graduation when
              prices stop being micro. */}
          <button
            type="button"
            onClick={() => setLogScale((v) => !v)}
            className={cn(
              "rounded-md border border-arc-border px-2 py-1 text-arc-text-muted transition-colors hover:text-arc-text",
              logScale && "bg-arc-surface-2 text-arc-text",
            )}
            title={logScale ? "Switch to linear scale" : "Switch to log scale"}
          >
            {logScale ? "Log" : "Lin"}
          </button>
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
