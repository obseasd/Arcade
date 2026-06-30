"use client";

import { ExternalLink, Twitter, MessageSquare, Globe, ArrowLeft, HelpCircle } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Address, erc20Abi, isAddress, parseAbiItem } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V3_POOL_ABI } from "@/lib/abis/v3";
import { ADDRESSES, LAUNCHPAD_CURVE_SUPPLY, LAUNCHPAD_GRADUATION_USDC, LAUNCHPAD_TOTAL_SUPPLY } from "@/lib/constants";
import { getLaunchpadGenerations } from "@/lib/launchpadGenerations";
import { useClankerMcap } from "@/lib/hooks/useClankerMcap";
import { useLaunchpadVolume } from "@/lib/hooks/useLaunchpadVolume";
import { useTokenImage, useTokenMetadata } from "@/lib/hooks/useTokenImage";
import { useWatchEvent } from "@/lib/hooks/useWatchEvent";
import { type TokenMetadata } from "@/lib/metadata";
import { formatAddress, formatToken, formatUSDC } from "@/lib/utils";
import { TokenIcon } from "@/components/ui/TokenIcon";
// Audit 2026-06-11 v2 Perf P0-3: PriceChart pulls lightweight-charts
// (~50 kB gzipped) and lives below the fold under the trade panel +
// header. Dynamic-import with ssr:false defers it out of the initial
// route bundle. Loading skeleton matches the chart's container height
// to avoid a layout shift while the chunk fetches.
const PriceChart = dynamic(
  () => import("@/components/launchpad/PriceChart").then((m) => m.PriceChart),
  { ssr: false, loading: () => <div className="h-full w-full rounded-2xl bg-arc-bg-elevated/50" /> },
);
import { TradePanel } from "@/components/launchpad/TradePanel";
import { ClankerTradePanel } from "@/components/launchpad/ClankerTradePanel";
import { CreatorTokenPanel } from "@/components/launchpad/CreatorTokenPanel";
import { CreatorTierBadge } from "@/components/creator/CreatorTierBadge";
import { PendingClaimBanner } from "@/components/launchpad/PendingClaimBanner";
import { TokenActivityPanel } from "@/components/launchpad/TokenActivityPanel";
import { Comments } from "@/components/launchpad/Comments";
import { Tooltip } from "@/components/ui/Tooltip";

const V3_SWAP_EVT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const BUY_EVT = parseAbiItem(
  "event Buy(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 newPriceQ64)",
);
const SELL_EVT = parseAbiItem(
  "event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 newPriceQ64)",
);

export default function TokenDetailPage() {
  const params = useParams();
  const addressParam = params.address as string;
  const isValid = isAddress(addressParam);
  const token = addressParam as Address;
  const [refreshKey, setRefreshKey] = useState(0);

  // Probe getTokenState on EVERY launchpad generation, then pick the
  // first one that returns a non-zero token (i.e. the generation that
  // actually minted this token). Without this multi-gen probe, a token
  // minted on a prior generation lands on the detail page and reads as
  // "Token not found" because ADDRESSES.launchpad only ever points at
  // the current generation. Also covers the race where a token has just
  // been minted on the current generation but ADDRESSES.launchpad has
  // not yet been bumped to that address.
  const generations = useMemo(() => getLaunchpadGenerations(), []);
  const stateProbe = useReadContracts({
    contracts: generations.map((g) => ({
      address: g.address,
      abi: LAUNCHPAD_ABI,
      functionName: "getTokenState" as const,
      args: isValid ? [token] : undefined,
    })),
    query: { enabled: isValid && generations.length > 0 },
  });
  const stateMatch = useMemo(() => {
    if (!stateProbe.data) return null;
    for (let i = 0; i < stateProbe.data.length; i++) {
      const r = stateProbe.data[i];
      if (r?.status !== "success") continue;
      const s = r.result as { token?: Address } | undefined;
      if (!s) continue;
      if (s.token && s.token !== "0x0000000000000000000000000000000000000000") {
        return { result: s, launchpad: generations[i].address };
      }
    }
    return null;
  }, [stateProbe.data, generations]);
  const tokenStateLaunchpad = stateMatch?.launchpad ?? ADDRESSES.launchpad;
  // Compatibility shim so the rest of the file (originally written
  // against a useReadContract result) keeps working without a wider
  // rewrite. refetch() rotates the whole probe so a stale read clears
  // on a live update.
  const tokenState = {
    data: stateMatch?.result,
    isLoading: stateProbe.isLoading,
    refetch: stateProbe.refetch,
  };

  const nameQ = useReadContract({
    address: isValid ? token : undefined,
    abi: erc20Abi,
    functionName: "name",
    query: { enabled: isValid },
  });
  const symbolQ = useReadContract({
    address: isValid ? token : undefined,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: isValid },
  });
  const mcapQ = useReadContract({
    // Route marketCap to the launchpad that actually owns this token
    // (matches the multi-gen probe above). Falls back to the current
    // generation while the probe is in flight so the cold render still
    // emits a valid call.
    address: tokenStateLaunchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "marketCap",
    args: isValid ? [token] : undefined,
    query: { enabled: isValid },
  });

  // Curve naturally fills at 20k USDC of real reserves; the constant used to
  // be exposed by the contract but was removed in the audit fixes (dead state).
  // The frontend uses the hardcoded value, which matches the curve math.
  const migrationTarget = LAUNCHPAD_GRADUATION_USDC;

  const state = tokenState.data as any;
  const symbol = (symbolQ.data as string | undefined) ?? "?";
  const name = (nameQ.data as string | undefined) ?? "Unnamed";
  const mcap = mcapQ.data as bigint | undefined;

  // Resolve the metadata JSON (handles inline data: + ipfs:// JSONs).
  const { metadata: resolvedMetadata } = useTokenMetadata(isValid ? token : undefined);
  const metadata: TokenMetadata = useMemo(
    () => resolvedMetadata ?? {},
    [resolvedMetadata],
  );
  const { image } = useTokenImage(isValid ? token : undefined);

  const tokensSold = (state?.tokensSold as bigint | undefined) ?? 0n;
  const migrated = !!state?.migrated;
  const isClanker = Number(state?.mode ?? 0) === 2;
  // Clanker FDV: the contract's `marketCap()` reads V2 reserves on what is
  // actually a V3 pool → reverts. We compute it client-side from slot0.
  const clankerMcap = useClankerMcap(isClanker && isValid ? token : undefined, isClanker ? (state?.v2Pair as Address | undefined) : undefined);
  const poolFeeQ = useReadContract({
    address: isClanker ? (state?.v2Pair as Address | undefined) : undefined,
    abi: V3_POOL_ABI,
    functionName: "fee",
    query: { enabled: isClanker && !!state?.v2Pair && state.v2Pair !== "0x0000000000000000000000000000000000000000" },
  });
  const feePct = isClanker
    ? (Number((poolFeeQ.data as number | undefined) ?? 0) / 10_000)
    : 1; // PUMP/Arcade curve fee
  const { volume: volumeRaw, volumeToken: volumeTokenRaw, isLoading: volLoading } = useLaunchpadVolume({
    token: isValid ? token : undefined,
    mode: state ? Number(state.mode) : undefined,
    pool: isClanker ? (state?.v2Pair as Address | undefined) : undefined,
    refreshKey,
  });

  // Live updates via WebSocket: bump refreshKey whenever a trade happens on
  // this token. The hooks downstream (volume, claimable, balances) refetch.
  // We ALSO call refetch on the core token state queries directly because
  // they don't depend on refreshKey via their queryKey.
  const bumpRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    tokenState.refetch();
    mcapQ.refetch();
  }, [tokenState, mcapQ]);
  useWatchEvent({
    address: isClanker ? (state?.v2Pair as Address | undefined) : undefined,
    event: V3_SWAP_EVT,
    enabled: isClanker && !!state?.v2Pair,
    onLogs: bumpRefresh,
  });
  useWatchEvent({
    address: !isClanker ? ADDRESSES.launchpad : undefined,
    event: BUY_EVT,
    args: isValid ? { token } : undefined,
    enabled: !isClanker && isValid,
    onLogs: bumpRefresh,
  });
  useWatchEvent({
    address: !isClanker ? ADDRESSES.launchpad : undefined,
    event: SELL_EVT,
    args: isValid ? { token } : undefined,
    enabled: !isClanker && isValid,
    onLogs: bumpRefresh,
  });
  const volumeLabel = volumeRaw !== undefined
    ? `$${formatUSDC(volumeRaw, 6, 0)}`
    : volLoading
      ? "Indexing…"
      : "-";
  const mcapLabel = isClanker
    ? clankerMcap
      ? clankerMcap.pairedSymbol === "USDC"
        ? `$${formatUSDC(clankerMcap.fdvRaw, 6, 0)}`
        : `${formatToken(clankerMcap.fdvRaw, clankerMcap.pairedDecimals, 2)} ${clankerMcap.pairedSymbol}`
      : "-"
    : mcap && mcap > 0n
      ? `$${formatUSDC(mcap, 6, 0)}`
      : "-";
  const progress = !migrated && LAUNCHPAD_CURVE_SUPPLY > 0n
    ? Number((tokensSold * 10_000n) / LAUNCHPAD_CURVE_SUPPLY) / 100
    : migrated
      ? 100
      : 0;

  if (!isValid) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <div className="arc-card p-8 text-center">
          <p className="text-arc-danger">Invalid token address.</p>
          <Link href="/launchpad" className="mt-4 inline-block text-arc-primary hover:underline">
            ← Back to launchpad
          </Link>
        </div>
      </div>
    );
  }

  if (tokenState.isLoading) {
    return <div className="mx-auto max-w-7xl px-4 py-16 text-center text-arc-text-muted">Loading…</div>;
  }

  if (!state || state.token === "0x0000000000000000000000000000000000000000") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <div className="arc-card p-8 text-center">
          <p className="text-arc-text-muted">Token not found on this launchpad.</p>
          <Link href="/launchpad" className="mt-4 inline-block text-arc-primary hover:underline">
            ← Back to launchpad
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Link
        href="/launchpad"
        className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted hover:text-arc-text"
      >
        <ArrowLeft className="h-4 w-4" /> Launchpad
      </Link>

      {/* Resume banners for any pending Twitter claims this wallet authorized.
          One per slot index; empty entries return null. With MAX_RECIPIENTS=4
          in the locker, 4 lookups is always upper-bounded. */}
      {isClanker && (
        <div className="mb-6 space-y-2">
          <PendingClaimBanner token={token} slotIndex={0n} />
          <PendingClaimBanner token={token} slotIndex={1n} />
          <PendingClaimBanner token={token} slotIndex={2n} />
          <PendingClaimBanner token={token} slotIndex={3n} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: header + chart + comments */}
        <div className="space-y-6 lg:col-span-2">
          {/* Header */}
          <div className="arc-card p-6">
            <div className="flex items-start gap-4">
              {/* TokenIcon resolves ipfs:// to a gateway internally so the
                  raw <img> works for both inline data: and ipfs:// URLs.
                  Without this, ipfs:// silently rendered nothing in the
                  header even when useTokenImage returned a value. */}
              <TokenIcon
                symbol={symbol}
                image={image}
                size={80}
                className="h-16 w-16 rounded-2xl border border-arc-border sm:h-20 sm:w-20"
              />
              {/* Hidden span left for layout-stability when useTokenImage
                  initially returns undefined and image hasn't resolved yet. */}
              {false && (
                <span className="hidden" aria-hidden>
                  {symbol}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h1 className="truncate text-xl font-semibold sm:text-2xl">{name}</h1>
                  <span className="tabular-nums text-arc-text-muted">${symbol}</span>
                  {Number(state?.mode ?? 0) === 2 ? (
                    <span className="rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/15 px-2 py-0.5 text-xs font-medium text-arc-text">
                      Clanker
                    </span>
                  ) : (
                    migrated && (
                      <span className="rounded-full border border-arc-success/30 bg-arc-success/10 px-2 py-0.5 text-xs font-medium text-arc-success">
                        Migrated to DEX
                      </span>
                    )
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-arc-text-muted">
                  {/* Show full address on lg+ and a truncated form on
                      mobile so a 42-char hex doesn't push the layout
                      sideways on a 375px viewport. */}
                  <span className="break-all sm:hidden">{formatAddress(token)} · created by</span>
                  <span className="hidden break-all sm:inline">{token} · created by</span>
                  <a
                    href={`https://testnet.arcscan.app/address/${state.creator}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-arc-text"
                  >
                    {formatAddress(state.creator)}
                  </a>
                  <CreatorTierBadge creator={state.creator} />

                  {/* Audit F-3: normalise the Twitter handle to a strict
                      `^[a-z0-9_]{1,15}$` shape before embedding in the href.
                      Without this, a deployer who pins metadata with a
                      handle like "victim?ref=phish" or "victim/../page"
                      produces a crafted x.com URL that looks legitimate
                      but redirects through abused x.com features. React
                      escapes the rendered text but does NOT URL-escape
                      the href value. Honest deployers with weird
                      capitalisation see their handle silently lowercased
                      (Twitter handles are case-insensitive anyway).
                      Handles that don't match the pattern → no link. */}
                  {(() => {
                    const raw = (metadata.creatorTwitter ?? "")
                      .replace(/^@+/, "")
                      .trim()
                      .toLowerCase();
                    if (!/^[a-z0-9_]{1,15}$/.test(raw)) return null;
                    return (
                      <a
                        href={`https://x.com/${raw}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Creator-claimed Twitter / X handle (unverified)"
                        className="inline-flex items-center gap-1 rounded-full border border-arc-border bg-arc-surface-2 px-1.5 py-0.5 text-[10px] text-arc-text transition-colors hover:bg-arc-surface-3"
                      >
                        <Twitter className="h-3 w-3" />@{raw}
                      </a>
                    );
                  })()}
                </div>
                {metadata.description && (
                  <p className="mt-3 max-w-2xl text-sm text-arc-text-muted">{metadata.description}</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {metadata.twitter && <SocialLink href={metadata.twitter} icon={<Twitter className="h-3.5 w-3.5" />}>Twitter</SocialLink>}
                  {metadata.telegram && <SocialLink href={metadata.telegram} icon={<MessageSquare className="h-3.5 w-3.5" />}>Telegram</SocialLink>}
                  {metadata.website && <SocialLink href={metadata.website} icon={<Globe className="h-3.5 w-3.5" />}>Website</SocialLink>}
                  {feePct > 0 && (
                    <span className="arc-pill cursor-default">
                      Fees: {feePct}%
                    </span>
                  )}
                  <a
                    href={`https://testnet.arcscan.app/address/${token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="arc-pill"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Explorer
                  </a>
                </div>
              </div>
            </div>

            {/* Stats row — bonding-curve modes show raised/progress/migration; Clanker
                tokens show pool-type info (no curve, LP locked from launch). */}
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Market cap"
                value={mcapLabel}
                hint="Price per token multiplied by the 1B total supply. Equivalent to FDV since all tokens are circulating from launch."
              />
              {Number(state?.mode ?? 0) === 2 ? (
                <>
                  <Stat
                    label="Volume"
                    value={volumeLabel}
                    hint="Cumulative USDC traded against this token's V3 pool since launch."
                  />
                  <Stat
                    label="Liquidity"
                    value="Single-sided"
                    hint="LP is single-sided (token only) at launch and converts to USDC as buyers consume positions. The position itself is locked forever."
                  />
                  <Stat label="Type" value="Clanker (V3 locked)" />
                </>
              ) : (
                <>
                  <Stat
                    label="Volume"
                    value={volumeLabel}
                    hint="Cumulative USDC traded through the bonding curve plus the V2 pool (if migrated)."
                  />
                  <Stat
                    label="Progress"
                    value={`${progress.toFixed(1)}%`}
                    hint="Fraction of the 800M curve supply sold. At 100% the launchpad seeds a V2 pool with the collected USDC and burns the LP."
                  />
                  <Stat
                    label={migrated ? "DEX pool" : "Migration at"}
                    value={
                      migrated && state.v2Pair
                        ? formatAddress(state.v2Pair)
                        : `$${formatUSDC(migrationTarget, 6, 0)}`
                    }
                    hint={
                      migrated
                        ? "The V2 pair address holding the migrated liquidity."
                        : "USDC threshold at which the curve fully sells out and migrates to a burned V2 pool."
                    }
                  />
                </>
              )}
            </div>

            {!migrated && (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-arc-bg-elevated">
                  <div
                    className="h-full bg-gradient-to-r from-arc-primary to-arc-primary-hover"
                    style={{ width: `${Math.min(progress, 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-arc-text-faint">
                  Curve auto-migrates to the DEX at 100%. All LP tokens are burned on migration.
                </div>
              </div>
            )}
          </div>

          {/* Chart */}
          <div className="arc-card p-5">
            <PriceChart
              token={token}
              mode={state ? Number(state.mode) : undefined}
              pool={isClanker ? (state?.v2Pair as Address | undefined) : undefined}
            />
          </div>

          {/* Activity: live trade feed + holders. The default Transactions tab
              listens to Buy/Sell (curve) or Swap (V3) events via WebSocket so
              new trades show up at the top in real time. */}
          <TokenActivityPanel
            token={token}
            symbol={symbol}
            mode={state ? Number(state.mode) : undefined}
            pool={isClanker ? (state?.v2Pair as Address | undefined) : undefined}
            totalSupplyRaw={LAUNCHPAD_TOTAL_SUPPLY * 10n ** 18n}
            launchpadAddress={tokenStateLaunchpad}
          />

          {/* Comments */}
          <Comments token={token} />
        </div>

        {/* Right: trade panel. CLANKER_V3 tokens trade through the V3 router on
            their locked single-sided pool; bonding-curve modes use the curve until
            migration, then the V2 router.
            order-first on mobile so the trade panel appears BEFORE the
            chart + activity feed - users on a 375px viewport should be
            able to buy/sell without scrolling past 2 screens of analytics. */}
        <div className="order-first space-y-6 lg:order-none">
          {isClanker ? (
            <ClankerTradePanel
              token={token}
              symbol={symbol}
              pool={state.v2Pair as Address}
              image={image}
              onTradeSuccess={bumpRefresh}
            />
          ) : (
            <TradePanel
              token={token}
              symbol={symbol}
              migrated={migrated}
              image={image}
              launchpad={tokenStateLaunchpad}
              onTradeSuccess={bumpRefresh}
            />
          )}
          {isClanker && (
            <CreatorTokenPanel
              token={token}
              symbol={symbol}
              pool={state.v2Pair as Address}
              volumeRaw={volumeRaw}
              volumeTokenRaw={volumeTokenRaw}
              slotHandles={metadata.slotTwitterHandles}
              refreshKey={refreshKey}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-arc-border bg-arc-bg-elevated p-3">
      <div className="flex items-center gap-1 text-xs text-arc-text-muted">
        {label}
        {hint && (
          <Tooltip content={hint}>
            <HelpCircle className="h-3 w-3 text-arc-text-faint" aria-label="Definition" />
          </Tooltip>
        )}
      </div>
      <div className="mt-1 truncate tabular-nums text-base font-medium">{value}</div>
    </div>
  );
}

/** Scheme allowlist for any href that comes from user-controlled token
 *  metadata. React does NOT block `javascript:` URIs in `href` in
 *  production builds (only emits a dev-mode warning) - audit FSEC-001
 *  walked the exploit path: attacker pins IPFS JSON with
 *  `{"twitter":"javascript:fetch(...+document.cookie)"}` -> any visitor
 *  who clicks the Twitter pill executes attacker JS in the arcade.trading
 *  origin, with wallet state in reach. Returning null when the parsed
 *  URL isn't http(s) hides the pill entirely - safer than rendering an
 *  inert anchor that still gets click-handlers in dev tools. */
function safeMetadataHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? href : null;
  } catch {
    return null;
  }
}

function SocialLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  const safe = safeMetadataHref(href);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="arc-pill hover:bg-arc-surface-3">
      {icon}
      {children}
    </a>
  );
}
