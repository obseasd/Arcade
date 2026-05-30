"use client";

import { useMemo } from "react";
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { sampleDistribution, sampleCumulativeSold, type SimulatorConfig } from "@/lib/lpSimulator/math";
import { CUMULATIVE_LINE_COLOR, positionColor } from "@/lib/lpSimulator/colors";

interface Props {
  config: SimulatorConfig;
}

function fmtMcap(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function LiquidityChart({ config }: Props) {
  const data = useMemo<Array<Record<string, number>>>(() => {
    const dist = sampleDistribution(config, 100);
    const cumu = sampleCumulativeSold(config, 100);
    // Merge: each row has mcap, pos0..posN (supply%), sold (cumulative).
    return dist.map((row, i) => ({
      ...row,
      sold: cumu[i]?.sold ?? 0,
    }));
  }, [config]);

  const maxSupply = useMemo(() => {
    let m = 0;
    for (const row of data) {
      let sum = 0;
      for (let i = 0; i < config.positions.length; i++) {
        sum += row[`pos${i}`] ?? 0;
      }
      if (sum > m) m = sum;
    }
    return m;
  }, [data, config.positions.length]);

  // Round Y-axis ceiling to a clean number for nicer ticks.
  const yMax = Math.max(0.05, Math.ceil(maxSupply * 100) / 100);

  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid stroke="rgba(40, 60, 90, 0.25)" strokeDasharray="3 3" />
          <XAxis
            dataKey="mcap"
            type="number"
            scale="log"
            domain={["dataMin", "dataMax"]}
            tickFormatter={fmtMcap}
            stroke="#92A8C2"
            fontSize={11}
            tickMargin={6}
          />
          <YAxis
            yAxisId="left"
            tickFormatter={(v) => `${(v * 100).toFixed(1)}%`}
            stroke="#92A8C2"
            fontSize={11}
            domain={[0, yMax]}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            stroke={CUMULATIVE_LINE_COLOR}
            fontSize={11}
            domain={[0, 1]}
          />
          <Tooltip
            contentStyle={{
              background: "rgba(6, 26, 54, 0.95)",
              border: "1px solid rgba(40, 60, 90, 0.6)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(label) => `Mcap ${fmtMcap(Number(label))}`}
            formatter={(value: unknown, name: unknown) => {
              const n = name as string;
              const v = Number(value) || 0;
              if (n === "sold") return [`${(v * 100).toFixed(1)}%`, "Supply sold"];
              const idx = Number(n.replace("pos", ""));
              return [`${(v * 100).toFixed(2)}%`, `Position ${idx + 1}`];
            }}
          />
          {config.positions.map((_, i) => (
            <Area
              key={i}
              yAxisId="left"
              type="monotone"
              dataKey={`pos${i}`}
              stackId="positions"
              stroke={positionColor(i)}
              fill={positionColor(i)}
              fillOpacity={0.35}
              strokeOpacity={0.9}
              isAnimationActive={false}
            />
          ))}
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="sold"
            stroke={CUMULATIVE_LINE_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
