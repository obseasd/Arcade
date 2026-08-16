"use client";

import Link from "next/link";
import { Star } from "lucide-react";
import { Address } from "viem";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { LaunchpadTokenInfo } from "@/lib/hooks/useLaunchpadTokens";
import { useClankerMcap } from "@/lib/hooks/useClankerMcap";
import { useTokenImage, useTokenMetadata } from "@/lib/hooks/useTokenImage";
import { SocialLinksRow } from "@/components/launchpad/SocialLinksRow";
import { FEATURED_TOKENS } from "@/lib/constants";
import { formatToken, formatUSDC, formatAddress } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface Props {
  token: LaunchpadTokenInfo;
  curveSupply: bigint;
  /** Render the logo with `priority` (above-the-fold first paint). The
   *  launchpad list passes true for the first row of cards so logos
   *  appear immediately instead of waiting for the lazy-load
   *  IntersectionObserver to fire. */
  priority?: boolean;
  /** Pre-computed USDC FDV from the page-level useClankerSortMcaps multicall.
   *  When set, the per-card useClankerMcap hook is disabled (no duplicate reads). */
  clankerFdvUsdc?: bigint;
}

// Display sanity ceiling for a launchpad token's market cap ($100M in 6-dp
// micros). A curve token graduates well under $100k and testnet AMM tokens are
// tiny, so any MC above this is a bad indexed/on-chain price (a few tokens on an
// old launchpad carry a ~1e6x-inflated spot price that renders as billions).
// Hide it rather than show garbage; the token detail page reads the value live
// and is unaffected.
const MAX_PLAUSIBLE_MCAP_MICRO = 100_000_000_000_000n; // $100,000,000

export function TokenCard({ token, curveSupply, priority, clankerFdvUsdc }: Props) {
  const progress = curveSupply > 0n ? Number((token.tokensSold * 10_000n) / curveSupply) / 100 : 0;
  // The bulk launchpad scan has ALREADY discovered each token's
  // metadataURI via useLaunchpadTokens' cross-generation TokenCreated
  // walk. Pass that URI straight through to useTokenImage so the hook
  // skips its own per-token getLogs scan entirely - that duplicate scan
  // was the single biggest contributor to the cold-load RPC storm
  // visible in Alchemy's "throughput limited" metric (24% rate). When
  // token.metadataURI is empty (token registered but URI hasn't been
  // discovered yet), the override is undefined and the hook falls back
  // to its own scan; cards still resolve eventually, just one round
  // trip slower.
  const uriOverride = token.metadataURI || undefined;
  const { image } = useTokenImage(token.address, uriOverride);
  const { metadata } = useTokenMetadata(token.address, uriOverride);
  const symbol = token.symbol ?? "?";

  // CLANKER_V3 = no bonding curve, locked single-sided V3 LP from birth.
  const isClanker = token.mode === 2;
  // Skip the per-card RPC reads when the page already computed the FDV.
  const needsPerCardMcap = isClanker && clankerFdvUsdc === undefined;
  const clankerMcap = useClankerMcap(needsPerCardMcap ? token.address : undefined, needsPerCardMcap ? token.v2Pair : undefined);
  // A USD market cap in 6-dp micros -> "$N" string, or null when it's absent or
  // implausibly large (a few tokens carry a ~1e6x-inflated indexed price).
  const usdMc = (v: bigint | undefined): string | null =>
    v !== undefined && v > 0n && v <= MAX_PLAUSIBLE_MCAP_MICRO ? `$${formatUSDC(v, 6, 0)}` : null;
  const mcapNode = isClanker
    ? clankerFdvUsdc !== undefined
      ? usdMc(clankerFdvUsdc)
      : clankerMcap
        ? clankerMcap.pairedSymbol === "USDC"
          ? usdMc(clankerMcap.fdvRaw)
          : `${formatToken(clankerMcap.fdvRaw, clankerMcap.pairedDecimals, 2)} ${clankerMcap.pairedSymbol}`
        : null
    : usdMc(token.marketCap);
  const isPump = token.mode === 0;
  const isArcade = token.mode === 1;
  const isFeatured = FEATURED_TOKENS.has(token.address.toLowerCase());
  // Line-2 launch mode (distinct from the lifecycle badge top-right).
  const modeLabel = isClanker ? "CLANKER" : isPump ? "PUMP" : isArcade ? "ARCADE" : "TOKEN";
  const createdAtNum = Number(token.createdAt);
  const isNew = createdAtNum > 0 && Date.now() / 1000 - createdAtNum < 86_400;
  // CLANKER (mode 2) is a direct launch: never migrates, so New (< 24h) or Live
  // only -- never Migrated / About to migrate.
  const status = isClanker
    ? isNew
      ? { label: "New", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" }
      : { label: "Live", className: "bg-arc-success/10 text-arc-success border-arc-success/30" }
    : token.migrated
      ? { label: "Migrated", className: "bg-arc-success/10 text-arc-success border-arc-success/30" }
      : progress > 95
        ? { label: "About to migrate", className: "bg-arc-warn/10 text-arc-warn border-arc-warn/30" }
        : isNew
          ? { label: "New", className: "bg-arc-cta-hover/15 text-arc-text border-arc-cta-hover/40" }
          : { label: "Live", className: "bg-arc-success/10 text-arc-success border-arc-success/30" };

  // CLANKER: show the fee recipient (@handle or wallet) instead of the deployer.
  const byLabel =
    isClanker && metadata?.creatorTwitter
      ? `@${metadata.creatorTwitter}`
      : `by ${formatAddress(
          (isClanker && metadata?.feeRecipient ? metadata.feeRecipient : token.creator) as `0x${string}`,
        )}`;

  const age = ageString(Number(token.createdAt));

  return (
    <Link
      href={`/launchpad/${token.address}`}
      className={cn(
        "arc-card group relative flex flex-col gap-2.5 p-4 transition-colors hover:border-arc-border-strong",
        isFeatured && "ring-1 ring-arc-cta-hover/40",
      )}
    >
      {/* Featured + lifecycle status badges, pinned top-right. */}
      <div className="absolute right-3 top-3 flex items-center gap-1.5">
        {isFeatured && (
          <span className="inline-flex items-center gap-1 rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/20 px-2 py-0.5 text-[10px] font-medium text-arc-text">
            <Star className="h-2.5 w-2.5 fill-current" /> Featured
          </span>
        )}
        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", status.className)}>
          {status.label}
        </span>
      </div>

      {/* Icon + name/mode/socials column. */}
      <div className="flex items-start gap-3">
        <TokenIcon
          symbol={symbol}
          image={image}
          size={56}
          className="rounded-xl border border-arc-border"
          priority={priority}
        />
        <div className="min-w-0 flex-1">
          {/* Line 1: name + ticker (pr clears the top-right badges). */}
          <div className={cn("flex items-center gap-2", isFeatured ? "pr-32" : "pr-16")}>
            <div className="truncate font-semibold">{token.name ?? "Unnamed"}</div>
            <div className="rounded-md bg-arc-surface-2 px-1.5 py-0.5 text-xs text-arc-text-muted">
              ${symbol}
            </div>
          </div>
          {/* Line 2: mode · MC · ago */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-arc-text-muted">
            <span className="font-semibold text-arc-text">{modeLabel}</span>
            {mcapNode && (
              <span>
                · MC <span className="tabular-nums text-arc-text">{mcapNode}</span>
              </span>
            )}
            <span>· {age}</span>
          </div>
          {/* Line 3: socials (left) + fee recipient / creator (right). */}
          <div className="mt-1.5 flex items-center gap-2">
            <SocialLinksRow metadata={metadata} />
            <span className="ml-auto truncate text-xs text-arc-text-faint">{byLabel}</span>
          </div>
        </div>
      </div>

      {/* Description (2-line clamp), only when present. */}
      {metadata?.description && (
        <p className="line-clamp-2 text-xs text-arc-text-muted">{metadata.description}</p>
      )}

      {isClanker ? (
        // Reserve the same height as the PUMP progress block so clanker and
        // pump cards stay identical in height, including on an all-clanker row.
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
