"use client";

import Link from "next/link";
import { useMemo } from "react";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { ARCADE_HOOK_MODE, ARCADE_HOOK_STATUS } from "@/lib/abis/arcadeHook";
import { type ArcadeHookTokenInfo } from "@/lib/hooks/useArcadeHookTokens";
import { useTokenImage, useTokenMetadata } from "@/lib/hooks/useTokenImage";
import { SocialLinksRow } from "@/components/launchpad/SocialLinksRow";
import { getFreshMeta } from "@/lib/freshMeta";
import { useV4TokenStats, type V4TokenStats } from "@/lib/hooks/useV4TokenStats";
import { useV4PoolPrice } from "@/lib/hooks/useV4PoolPrice";
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
export function V4TokenCard({ token, priority, preloadedStats }: { token: ArcadeHookTokenInfo; priority?: boolean; preloadedStats?: Omit<V4TokenStats, "isLoading"> }) {
  const liveStats = useV4TokenStats(token.address, !preloadedStats);
  const stats: V4TokenStats = preloadedStats
    ? { ...preloadedStats, isLoading: false }
    : liveStats;
  // Prefer the hook-cached metadataURI (from TokenLaunched); fall back to the
  // subgraph's when the on-chain scan came up empty, so the logo still resolves.
  const metadataURI =
    token.metadataURI || stats.metadataURI || getFreshMeta(token.address) || undefined;
  const { image } = useTokenImage(token.address, metadataURI);
  const { metadata } = useTokenMetadata(token.address, metadataURI);
  const symbol = token.symbol ?? "?";
  // Prefer the subgraph launch time (reliable) over the flaky on-chain event
  // scan; fall back to the scan only when the subgraph hasn't indexed it yet.
  const createdAtSec = stats.createdAtSec > 0 ? stats.createdAtSec : token.createdAt;

  const isClanker =
    token.mode === ARCADE_HOOK_MODE.CLANKER || token.mode === ARCADE_HOOK_MODE.CLANKER_V3;
  const isFeatured = FEATURED_TOKENS.has(token.address.toLowerCase());

  // CLANKER has a real pool price from launch (single-sided LP at a fixed seed
  // price), but stats.priceUsd is subgraph-trade-derived and stays undefined
  // until the first trade -- so a fresh CLANKER showed no MC. Fall back to the
  // on-chain V4 pool spot price so its market cap renders immediately. No-op for
  // PUMP: the arg is undefined (pre-graduation PUMP trades on the curve, not
  // this pool), so it keeps using the subgraph trade price.
  const clankerSpotPrice = useV4PoolPrice(isClanker ? token.address : undefined);
  const priceUsd = stats.priceUsd ?? clankerSpotPrice;
  // Clamp implausible market caps ($100M ceiling): a few tokens carry a
  // ~1e6x-inflated indexed/pool price that renders as billions. Hide it rather
  // than show garbage (this was the "MC reappears after back-navigation" bug --
  // the v4 stats price resolves from cache on return and this path was
  // unclamped, unlike TokenCard).
  const mcapUsd = priceUsd ? priceUsd * Number(LAUNCHPAD_TOTAL_SUPPLY) : 0;
  const mcapNode =
    mcapUsd > 0 && mcapUsd <= 100_000_000
      ? `$${mcapUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : null;

  const progress = useMemo(() => {
    if (LAUNCHPAD_CURVE_SUPPLY === 0n) return 0;
    return Math.min(100, Number((token.tokensSold * 10_000n) / LAUNCHPAD_CURVE_SUPPLY) / 100);
  }, [token.tokensSold]);

  // Top-right STATUS badge = lifecycle state (distinct from the PUMP/CLANKER mode
  // on line 2). "New" is purely age-based (< 24h, ANY mode); past a day it reads
  // "Live" unless it is migrating / has migrated.
  const isNew = createdAtSec > 0 && Date.now() / 1000 - createdAtSec < 86_400;
  // CLANKER is a direct launch: it never migrates, so it only ever reads
  // New (< 24h) or Live -- never Migrated / About to migrate (its on-chain
  // status is GRADUATED from birth, which must NOT surface as "Migrated").
  const status = isClanker
    ? isNew
      ? { label: "New", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" }
      : null
    : token.status === ARCADE_HOOK_STATUS.GRADUATED
      ? { label: "Migrated", className: "bg-arc-success/10 text-arc-success border-arc-success/30" }
      : progress > 95
        ? { label: "About to migrate", className: "bg-arc-warn/10 text-arc-warn border-arc-warn/30" }
        : isNew
          ? { label: "New", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" }
          : null;

  // CLANKER: show who earns the creator fees (the @handle or the recipient wallet)
  // instead of the deployer. PUMP / fallback: the deployer/creator.
  const byLabel =
    isClanker && metadata?.creatorTwitter
      ? `@${metadata.creatorTwitter}`
      : `by ${formatAddress(
          (isClanker && metadata?.feeRecipient ? metadata.feeRecipient : token.creator) as `0x${string}`,
        )}`;

  return (
    <Link
      href={`/launchpad/v4hook/${token.address}`}
      className={cn(
        "arc-card group relative flex flex-col gap-2.5 p-4 transition-colors hover:border-arc-border-strong",
        isFeatured && "ring-1 ring-arc-cta-hover/40",
      )}
    >
      {/* Lifecycle status badge, pinned top-right (hidden for a steady "Live" token). */}
      {status && (
        <span
          className={cn(
            "absolute right-3 top-3 rounded-full border px-2 py-0.5 text-[10px] font-medium",
            status.className,
          )}
        >
          {status.label}
        </span>
      )}

      {/* Icon + name/mode/socials column. */}
      <div className="flex items-start gap-3">
        <TokenIcon symbol={symbol} image={image} size={56} className="rounded-xl border border-arc-border" priority={priority} />
        <div className="min-w-0 flex-1">
          {/* Line 1: name + ticker (pr clears the top-right badge when present). */}
          <div className={cn("flex items-center gap-2", status && "pr-16")}>
            <div className="truncate font-semibold">{token.name ?? "Unnamed"}</div>
            <div className="rounded-md bg-arc-surface-2 px-1.5 py-0.5 text-xs text-arc-text-muted">${symbol}</div>
          </div>
          {/* Line 2: mode · MC · ago */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-arc-text-muted">
            <span className="font-semibold text-arc-text">{isClanker ? "CLANKER" : "PUMP"}</span>
            {mcapNode && (
              <span>
                · MC <span className="tabular-nums text-arc-text">{mcapNode}</span>
              </span>
            )}
            {createdAtSec > 0 && <span>· {ageString(createdAtSec)}</span>}
          </div>
          {/* Line 3: social icons (left) + fee recipient / creator (right),
              aligned under the mode line. */}
          <div className="mt-1.5 flex items-center gap-2">
            <SocialLinksRow metadata={metadata} />
            <span className="ml-auto truncate text-xs text-arc-text-faint">{byLabel}</span>
          </div>
        </div>
      </div>

      {/* Description (2-line clamp), only when the token has one. */}
      {metadata?.description && (
        <p className="line-clamp-2 text-xs text-arc-text-muted">{metadata.description}</p>
      )}

      {isClanker ? (
        // CLANKER has no bonding curve, but reserve the EXACT same vertical
        // space as the PUMP progress block (mutedText row + h-2 bar) so a
        // clanker card keeps an identical height to a pump card -- including on
        // an all-clanker grid row where there is no pump card to stretch it.
        <div aria-hidden className="mt-auto invisible">
          <div className="mb-1 flex justify-between text-xs">
            <span>Bonding progress</span>
            <span>0%</span>
          </div>
          <div className="h-2" />
        </div>
      ) : (
        <div className="mt-auto">
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
