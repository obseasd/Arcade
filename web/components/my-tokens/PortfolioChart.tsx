"use client";

import {
    Area,
    AreaChart,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    XAxis,
    YAxis,
} from "recharts";

/**
 * Extracted from `/my-tokens` so the recharts dep can be code-split out of
 * the main `/my-tokens` chunk. Audit 2026-06-11 v2 Perf P0-1: the
 * `/my-tokens` route was 503 kB First Load JS largely because of this
 * single placeholder chart waiting on the indexer. Dynamic import
 * (`next/dynamic` with `ssr: false`) keeps recharts in its own chunk so
 * the initial route bundle stays in line with `/launchpad/[address]`
 * (~310 kB).
 *
 * The series shape is a simple `{ x: number; y: number }[]`. The component
 * intentionally takes no other props — placeholder data lives at the call
 * site and the visual is identical to the previous inline render.
 */
export interface PortfolioPoint {
    x: number;
    y: number;
}

export function PortfolioChart({ series }: { series: PortfolioPoint[] }) {
    return (
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series}>
                <defs>
                    <linearGradient id="portfolioFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#15508F" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#15508F" stopOpacity={0} />
                    </linearGradient>
                </defs>
                <XAxis dataKey="x" hide />
                <YAxis hide domain={["dataMin", "dataMax"]} />
                <RechartsTooltip
                    cursor={false}
                    contentStyle={{
                        background: "rgba(6, 26, 54, 0.95)",
                        border: "1px solid rgba(40, 60, 90, 0.6)",
                        borderRadius: 8,
                        fontSize: 11,
                        padding: "4px 8px",
                    }}
                    formatter={(v: number) => [`$${v.toFixed(2)}`, ""]}
                    labelFormatter={() => ""}
                />
                <Area
                    type="monotone"
                    dataKey="y"
                    stroke="#15508F"
                    strokeWidth={2}
                    fill="url(#portfolioFill)"
                    isAnimationActive={false}
                />
            </AreaChart>
        </ResponsiveContainer>
    );
}
