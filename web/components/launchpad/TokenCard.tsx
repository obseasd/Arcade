"use client";

import Link from "next/link";
import { Address } from "viem";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { LaunchpadTokenInfo } from "@/lib/hooks/useLaunchpadTokens";
import { formatUSDC, formatAddress } from "@/lib/utils";
import { getImageUrl } from "@/lib/metadata";
import { cn } from "@/lib/utils";

interface Props {
  token: LaunchpadTokenInfo;
  curveSupply: bigint;
}

export function TokenCard({ token, curveSupply }: Props) {
  const progress = curveSupply > 0n ? Number((token.tokensSold * 10_000n) / curveSupply) / 100 : 0;
  const image = getImageUrl(token.metadataURI);
  const symbol = token.symbol ?? "?";

  const status = token.migrated
    ? { label: "Migrated", className: "bg-arc-success/10 text-arc-success border-arc-success/30" }
    : progress > 95
      ? { label: "About to migrate", className: "bg-arc-warn/10 text-arc-warn border-arc-warn/30" }
      : { label: "Active", className: "bg-arc-primary-soft text-arc-primary border-arc-border-strong" };

  const age = ageString(Number(token.createdAt));

  return (
    <Link
      href={`/launchpad/${token.address}`}
      className="arc-card group flex flex-col gap-3 p-4 transition-colors hover:border-arc-border-strong"
    >
      <div className="flex items-start gap-3">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={symbol}
            className="h-14 w-14 rounded-xl border border-arc-border object-cover"
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
          />
        ) : (
          <TokenIcon symbol={symbol} size={56} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate font-semibold">{token.name ?? "Unnamed"}</div>
            <div className="rounded-md bg-arc-surface-2 px-1.5 py-0.5 text-xs text-arc-text-muted">
              ${symbol}
            </div>
          </div>
          <div className="mt-0.5 text-xs text-arc-text-muted">
            by {formatAddress(token.creator)} · {age}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", status.className)}>
              {status.label}
            </span>
            {token.marketCap !== undefined && (
              <span className="text-xs text-arc-text-muted">
                MC <span className="tabular-nums text-arc-text">${formatUSDC(token.marketCap, 6, 0)}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 flex justify-between text-xs text-arc-text-muted">
          <span>Bonding progress</span>
          <span className="tabular-nums text-arc-text">{progress.toFixed(1)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-arc-bg-elevated">
          <div
            className="h-full bg-gradient-to-r from-arc-primary to-arc-primary-hover transition-all"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      </div>
    </Link>
  );
}

function ageString(unixSeconds: number) {
  if (!unixSeconds) return "—";
  const seconds = Math.max(1, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
