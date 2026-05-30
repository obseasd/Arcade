"use client";

import { TrendingUp, DollarSign, Clock } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { useCreatorEarnings, type TokenEarnings } from "@/lib/hooks/useCreatorEarnings";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { cn } from "@/lib/utils";

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

/**
 * Header card on /my-tokens summarising creator LP earnings: total claimed in
 * the past 7 days, currently-pending preview, a sparkline of daily claims, and
 * the top tokens by claim amount.
 *
 * Self-hiding: renders nothing if the wallet has zero positions and zero
 * pending. For users without any Clanker V3 launches, the card is invisible.
 */
export function CreatorEarningsCard() {
  const { claimedUsd, pendingUsd, perToken, daily, fullyLoaded, isLoading } = useCreatorEarnings();

  const totalAcrossPeriods = claimedUsd + pendingUsd;
  if (!isLoading && totalAcrossPeriods === 0 && perToken.length === 0) return null;

  const chartData = daily.map((d, i) => ({ x: i, y: d.amountUsd }));

  return (
    <div className="arc-card relative overflow-hidden p-5">
      {/* Subtle gradient flair */}
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          background:
            "radial-gradient(ellipse at top right, rgba(34, 197, 94, 0.08), transparent 60%)",
        }}
        aria-hidden
      />
      <div className="relative">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-arc-success/15 text-arc-success">
              <TrendingUp className="h-3.5 w-3.5" />
            </div>
            <h3 className="text-sm font-semibold">Creator earnings</h3>
            <span className="text-[10px] uppercase tracking-wider text-arc-text-faint">
              {fullyLoaded ? "Last 7 days" : "Last 14h"}
            </span>
          </div>
          {isLoading && (
            <span className="text-[10px] text-arc-text-faint">Updating…</span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1fr_auto]">
          {/* Claimed */}
          <Metric
            label="Claimed"
            value={fmtUsd(claimedUsd)}
            icon={<DollarSign className="h-3.5 w-3.5" />}
            tone="success"
          />
          {/* Pending */}
          <Metric
            label="Pending (unclaimed)"
            value={fmtUsd(pendingUsd)}
            icon={<Clock className="h-3.5 w-3.5" />}
            tone={pendingUsd > 0 ? "warn" : "muted"}
          />
          {/* Sparkline */}
          {daily.length > 1 && (
            <div className="hidden h-16 w-32 md:block">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="creatorSpark" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10B981" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <YAxis hide domain={[0, "dataMax"]} />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(6, 26, 54, 0.95)",
                      border: "1px solid rgba(40, 60, 90, 0.6)",
                      borderRadius: 8,
                      fontSize: 11,
                      padding: "4px 8px",
                    }}
                    formatter={(v: number) => [fmtUsd(v), "Claimed"]}
                    labelFormatter={() => ""}
                  />
                  <Area
                    type="monotone"
                    dataKey="y"
                    stroke="#10B981"
                    strokeWidth={1.5}
                    fill="url(#creatorSpark)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Top earners */}
        {perToken.length > 0 && (
          <div className="mt-4 border-t border-arc-border/60 pt-3">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-arc-text-muted">
              Top tokens
            </div>
            <div className="space-y-1.5">
              {perToken.slice(0, 5).map((t) => (
                <TokenRow key={t.token} earnings={t} totalClaimed={claimedUsd} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone: "success" | "warn" | "muted";
}) {
  const toneClass =
    tone === "success" ? "text-arc-success" : tone === "warn" ? "text-amber-400" : "text-arc-text";
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-arc-text-muted">
        <span className="text-arc-text-faint">{icon}</span>
        {label}
      </div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", toneClass)}>{value}</div>
    </div>
  );
}

function TokenRow({ earnings, totalClaimed }: { earnings: TokenEarnings; totalClaimed: number }) {
  const pct = totalClaimed > 0 ? (earnings.amountUsd / totalClaimed) * 100 : 0;
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <AutoTokenIcon address={earnings.token} symbol={earnings.symbol} size={20} />
        <span className="truncate font-medium">${earnings.symbol ?? "Token"}</span>
        <span className="text-arc-text-faint">
          {earnings.payouts} payout{earnings.payouts === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex items-center gap-2 tabular-nums">
        <span className="text-arc-text-muted">{pct.toFixed(0)}%</span>
        <span className="w-16 text-right font-semibold">{fmtUsd(earnings.amountUsd)}</span>
      </div>
    </div>
  );
}
