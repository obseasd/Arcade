"use client";

import { useEffect, useState } from "react";
import { Address } from "viem";
import { usePublicClient } from "wagmi";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";

interface PricePoint {
  t: number;
  price: number;
  type: "buy" | "sell";
}

/**
 * Reads Buy/Sell events for `token` from the launchpad and renders the
 * implied USDC-per-token price over time. The contract emits a Q64.64
 * fixed-point price (USDC raw per token raw); we convert to a human price
 * (USDC per token, decimal).
 */
export function PriceChart({ token }: { token: Address }) {
  const publicClient = usePublicClient();
  const [data, setData] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!publicClient || !token) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [buyEvent, sellEvent] = [
          LAUNCHPAD_ABI.find((a) => a.type === "event" && a.name === "Buy"),
          LAUNCHPAD_ABI.find((a) => a.type === "event" && a.name === "Sell"),
        ];

        const [buys, sells] = await Promise.all([
          publicClient.getLogs({
            address: ADDRESSES.launchpad,
            event: buyEvent as any,
            args: { token } as any,
            fromBlock: 0n,
            toBlock: "latest",
          }),
          publicClient.getLogs({
            address: ADDRESSES.launchpad,
            event: sellEvent as any,
            args: { token } as any,
            fromBlock: 0n,
            toBlock: "latest",
          }),
        ]);

        const points: PricePoint[] = [];
        const tagged: { type: "buy" | "sell"; log: any }[] = [
          ...buys.map((l) => ({ type: "buy" as const, log: l })),
          ...sells.map((l) => ({ type: "sell" as const, log: l })),
        ];
        for (const { type, log } of tagged) {
          const args = log.args ?? {};
          const priceQ64 = args.newPriceQ64 as bigint | undefined;
          if (priceQ64 === undefined) continue;
          // Convert Q64.64 to USDC per whole token:
          //   priceQ64 / 2^64 gives USDC_raw per token_raw.
          //   Multiply by 10^18 (token decimals), divide by 10^6 (USDC) = * 10^12 / 2^64
          const numer = priceQ64 * 1_000_000_000_000n;
          const denom = 1n << 64n;
          const price = Number(numer / denom) + Number(numer % denom) / Number(denom);
          const block = await publicClient.getBlock({ blockNumber: log.blockNumber as bigint });
          points.push({ t: Number(block.timestamp), price, type });
        }
        points.sort((a, b) => a.t - b.t);
        if (!cancelled) setData(points);
      } catch {
        if (!cancelled) setData([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-arc-text-faint">Loading chart…</div>;
  }
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-arc-text-muted">
        No trades yet - be the first.
      </div>
    );
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#345A78" stopOpacity={0.6} />
              <stop offset="100%" stopColor="#345A78" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            tick={{ fill: "#92A8C2", fontSize: 11 }}
            axisLine={{ stroke: "#15324F" }}
            tickLine={{ stroke: "#15324F" }}
          />
          <YAxis
            dataKey="price"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v) => v < 0.001 ? v.toExponential(2) : v.toFixed(6)}
            tick={{ fill: "#92A8C2", fontSize: 11 }}
            axisLine={{ stroke: "#15324F" }}
            tickLine={{ stroke: "#15324F" }}
            width={70}
          />
          <Tooltip
            contentStyle={{
              background: "#061A36",
              border: "1px solid #15324F",
              borderRadius: 8,
              color: "#E5EEF8",
              fontSize: 12,
            }}
            formatter={(value: number) => [
              value < 0.001 ? value.toExponential(4) : value.toFixed(8),
              "USDC",
            ]}
            labelFormatter={(t) => new Date((t as number) * 1000).toLocaleString()}
          />
          <Area type="monotone" dataKey="price" stroke="#42729A" strokeWidth={2} fill="url(#priceGrad)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
