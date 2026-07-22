"use client";

import Link from "next/link";
import { useMemo } from "react";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { ARCADE_HOOK_MODE, ARCADE_HOOK_STATUS } from "@/lib/abis/arcadeHook";
import { type ArcadeHookTokenInfo } from "@/lib/hooks/useArcadeHookTokens";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { useV4TokenStats } from "@/lib/hooks/useV4TokenStats";
import { LAUNCHPAD_CURVE_SUPPLY, LAUNCHPAD_TOTAL_SUPPLY, FEATURED_TOKENS } from "@/lib/constants";
import { formatAddress } from "@/lib/utils";
import { cn } from "@/lib/utils";

/** Compact "Xs/m/h/d ago" from a unix-seconds timestamp. */
function ageString(createdAtSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - createdAtSec);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Launchpad grid card for an ArcadeHook (V4) token. Same visual language as the
 * legacy TokenCard, but links to the /launchpad/v4hook detail and reflects the
 * V4 lifecycle: CLANKER is a direct single-sided locked-LP launch (NEVER shows
 * "Graduated"); PUMP shows its bonding-curve progress.
 */
export function V4TokenCard({ token, priority }: { token: ArcadeHookTokenInfo; priority?: boolean }) {
  // The hook surface already carries the metadataURI (from TokenLaunched), so
  // pass it straight through -- no per-token event scan needed for the logo.
  const { image } = useTokenImage(token.address, token.metadataURI || undefined);
  const stats = useV4TokenStats(token.address);
  const symbol = token.symbol ?? "?";
  // Prefer the subgraph launch time (reliable) over the flaky on-chain event
  // scan; fall back to the scan only when the subgraph hasn't indexed it yet.
  const createdAtSec = stats.createdAtSec > 0 ? stats.createdAtSec : token.createdAt;

  const isClanker =
    token.mode === ARCADE_HOOK_MODE.CLANKER || token.mode === ARCADE_HOOK_MODE.CLANKER_V3;
  const isFeatured = FEATURED_TOKENS.has(token.address.toLowerCase());

  const mcapNode = stats.priceUsd
    ? `$${(stats.priceUsd * Number(LAUNCHPAD_TOTAL_SUPPLY)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : null;

  const progress = useMemo(() => {
    if (LAUNCHPAD_CURVE_SUPPLY === 0n) return 0;
    return Math.min(100, Number((token.tokensSold * 10_000n) / LAUNCHPAD_CURVE_SUPPLY) / 100);
  }, [token.tokensSold]);

  const status = isClanker
    ? { label: "Clanker", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" }
    : token.status === ARCADE_HOOK_STATUS.GRADUATED
      ? { label: "Graduated", className: "bg-arc-success/10 text-arc-success border-arc-success/30" }
      : progress > 95
        ? { label: "About to migrate", className: "bg-arc-warn/10 text-arc-warn border-arc-warn/30" }
        : { label: "Pump", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" };

  return (
    <Link
      href={`/launchpad/v4hook/${token.address}`}
      className={cn(
        "arc-card group flex flex-col gap-3 p-4 transition-colors hover:border-arc-border-strong",
        isFeatured && "ring-1 ring-arc-cta-hover/40",
      )}
    >
      <div className="flex items-start gap-3">
        <TokenIcon symbol={symbol} image={image} size={56} className="rounded-xl border border-arc-border" priority={priority} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate font-semibold">{token.name ?? "Unnamed"}</div>
            <div className="rounded-md bg-arc-surface-2 px-1.5 py-0.5 text-xs text-arc-text-muted">${symbol}</div>
          </div>
          <div className="mt-0.5 text-xs text-arc-text-muted">
            by {formatAddress(token.creator)}
            {createdAtSec > 0 && <> · {ageString(createdAtSec)}</>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 gap-y-1">
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", status.className)}>
              {status.label}
            </span>
            {mcapNode && (
              <span className="text-xs text-arc-text-muted">
                MC <span className="tabular-nums text-arc-text">{mcapNode}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {isClanker ? (
        <div className="text-xs text-arc-text-faint">Locked single-sided V4 LP · tradeable from launch</div>
      ) : (
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
      )}
    </Link>
  );
}
