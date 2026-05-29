"use client";

import Link from "next/link";
import { Star } from "lucide-react";
import { Address } from "viem";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { LaunchpadTokenInfo } from "@/lib/hooks/useLaunchpadTokens";
import { useClankerMcap } from "@/lib/hooks/useClankerMcap";
import { useTokenMetadataURI } from "@/lib/hooks/useTokenMetadataURI";
import { FEATURED_TOKENS } from "@/lib/constants";
import { formatToken, formatUSDC, formatAddress } from "@/lib/utils";
import { getImageUrl } from "@/lib/metadata";
import { cn } from "@/lib/utils";

interface Props {
  token: LaunchpadTokenInfo;
  curveSupply: bigint;
}

export function TokenCard({ token, curveSupply }: Props) {
  const progress = curveSupply > 0n ? Number((token.tokensSold * 10_000n) / curveSupply) / 100 : 0;
  // The list hook's bulk scan can be slow (multi-second on Arc RPC) so the
  // image URL may not be populated yet. Subscribe to the per-token hook which
  // hits a module-level cache and lazy-fetches via an indexed-arg getLogs that
  // returns in ~100ms.
  const { metadataURI: liveMetadataURI } = useTokenMetadataURI(token.address);
  const metadataURI = liveMetadataURI || token.metadataURI;
  const image = getImageUrl(metadataURI);
  const symbol = token.symbol ?? "?";

  // CLANKER_V3 = no bonding curve, locked single-sided V3 LP from birth.
  const isClanker = token.mode === 2;
  // Contract's marketCap() reads V2 reserves on a V3 pool for Clankers → reverts;
  // compute it client-side from slot0 instead.
  const clankerMcap = useClankerMcap(isClanker ? token.address : undefined, isClanker ? token.v2Pair : undefined);
  const mcapNode = isClanker
    ? clankerMcap
      ? clankerMcap.pairedSymbol === "USDC"
        ? `$${formatUSDC(clankerMcap.fdvRaw, 6, 0)}`
        : `${formatToken(clankerMcap.fdvRaw, clankerMcap.pairedDecimals, 2)} ${clankerMcap.pairedSymbol}`
      : null
    : token.marketCap && token.marketCap > 0n
      ? `$${formatUSDC(token.marketCap, 6, 0)}`
      : null;
  const isPump = token.mode === 0;
  const isArcade = token.mode === 1;
  const isFeatured = FEATURED_TOKENS.has(token.address.toLowerCase());
  const status = isClanker
    ? { label: "Clanker", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" }
    : token.migrated
      ? { label: "Migrated", className: "bg-arc-success/10 text-arc-success border-arc-success/30" }
      : progress > 95
        ? { label: "About to migrate", className: "bg-arc-warn/10 text-arc-warn border-arc-warn/30" }
        : isPump
          ? { label: "Pump", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" }
          : isArcade
            ? { label: "Arcade", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" }
            : { label: "Active", className: "bg-arc-primary-soft text-arc-primary border-arc-border-strong" };

  const age = ageString(Number(token.createdAt));

  return (
    <Link
      href={`/launchpad/${token.address}`}
      className={cn(
        "arc-card group flex flex-col gap-3 p-4 transition-colors hover:border-arc-border-strong",
        isFeatured && "ring-1 ring-arc-cta-hover/40",
      )}
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
            {isFeatured && (
              <span className="inline-flex items-center gap-1 rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/20 px-2 py-0.5 text-[10px] font-medium text-arc-text">
                <Star className="h-2.5 w-2.5 fill-current" /> Featured
              </span>
            )}
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
        <div className="text-xs text-arc-text-faint">Locked single-sided V3 LP · tradeable from launch</div>
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

function ageString(unixSeconds: number) {
  if (!unixSeconds) return "-";
  const seconds = Math.max(1, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
