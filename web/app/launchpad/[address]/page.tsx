"use client";

import { ExternalLink, Twitter, MessageSquare, Globe, ArrowLeft, HelpCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Address, erc20Abi, isAddress, parseAbiItem } from "viem";
import { useReadContract } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V3_POOL_ABI } from "@/lib/abis/v3";
import { ADDRESSES, LAUNCHPAD_TOTAL_SUPPLY } from "@/lib/constants";
import { useClankerMcap } from "@/lib/hooks/useClankerMcap";
import { useLaunchpadVolume } from "@/lib/hooks/useLaunchpadVolume";
import { useTokenImage, useTokenMetadata } from "@/lib/hooks/useTokenImage";
import { useWatchEvent } from "@/lib/hooks/useWatchEvent";
import { type TokenMetadata } from "@/lib/metadata";
import { formatAddress, formatToken, formatUSDC } from "@/lib/utils";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { PriceChart } from "@/components/launchpad/PriceChart";
import { TradePanel } from "@/components/launchpad/TradePanel";
import { ClankerTradePanel } from "@/components/launchpad/ClankerTradePanel";
import { CreatorTokenPanel } from "@/components/launchpad/CreatorTokenPanel";
import { TokenActivityPanel } from "@/components/launchpad/TokenActivityPanel";
import { Comments } from "@/components/launchpad/Comments";
import { Tooltip } from "@/components/ui/Tooltip";

const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
const MIGRATION_TARGET_FALLBACK = 20_000n * 10n ** 6n;

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

  const tokenState = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "getTokenState",
    args: isValid ? [token] : undefined,
    query: { enabled: isValid },
  });

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
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "marketCap",
    args: isValid ? [token] : undefined,
    query: { enabled: isValid },
  });

  // Curve naturally fills at 20k USDC of real reserves; the constant used to
  // be exposed by the contract but was removed in the audit fixes (dead state).
  // The frontend uses the hardcoded value, which matches the curve math.
  const migrationTarget = MIGRATION_TARGET_FALLBACK;

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
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
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
  const progress = !migrated && CURVE_SUPPLY > 0n
    ? Number((tokensSold * 10_000n) / CURVE_SUPPLY) / 100
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

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: header + chart + comments */}
        <div className="space-y-6 lg:col-span-2">
          {/* Header */}
          <div className="arc-card p-6">
            <div className="flex items-start gap-4">
              {image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image}
                  alt={symbol}
                  className="h-20 w-20 rounded-2xl border border-arc-border object-cover"
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                />
              ) : (
                <TokenIcon symbol={symbol} size={80} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h1 className="truncate text-2xl font-semibold">{name}</h1>
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
                  <span>{token} · created by</span>
                  <a
                    href={`https://testnet.arcscan.app/address/${state.creator}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-arc-text"
                  >
                    {formatAddress(state.creator)}
                  </a>
                  {metadata.creatorTwitter && (
                    <a
                      href={`https://x.com/${metadata.creatorTwitter}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Creator-claimed Twitter / X handle (unverified)"
                      className="inline-flex items-center gap-1 rounded-full border border-arc-border bg-arc-surface-2 px-1.5 py-0.5 text-[10px] text-arc-text transition-colors hover:bg-arc-surface-3"
                    >
                      <Twitter className="h-3 w-3" />@{metadata.creatorTwitter}
                    </a>
                  )}
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
            launchpadAddress={ADDRESSES.launchpad}
          />

          {/* Comments */}
          <Comments token={token} />
        </div>

        {/* Right: trade panel. CLANKER_V3 tokens trade through the V3 router on
            their locked single-sided pool; bonding-curve modes use the curve until
            migration, then the V2 router. */}
        <div className="space-y-6">
          {isClanker ? (
            <ClankerTradePanel
              token={token}
              symbol={symbol}
              pool={state.v2Pair as Address}
              image={image}
              onTradeSuccess={() => setRefreshKey((k) => k + 1)}
            />
          ) : (
            <TradePanel
              token={token}
              symbol={symbol}
              migrated={migrated}
              image={image}
              onTradeSuccess={() => setRefreshKey((k) => k + 1)}
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

function SocialLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="arc-pill hover:bg-arc-surface-3">
      {icon}
      {children}
    </a>
  );
}
