"use client";

import { Activity, Users, ExternalLink } from "lucide-react";
import { useState, useMemo } from "react";
import { Address } from "viem";
import { useTokenTrades, type Trade } from "@/lib/hooks/useTokenTrades";
import { useTokenHolders, type Holder } from "@/lib/hooks/useTokenHolders";
import { ADDRESSES } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { formatToken, formatUSDC, formatAddress, cn } from "@/lib/utils";

interface Props {
  token: Address;
  symbol: string;
  mode?: number;
  /** V3 pool address (for Clanker tokens) so we know which contract emits Swaps. */
  pool?: Address;
  /** Total supply of the token in raw 18-dec units, for the holder %. */
  totalSupplyRaw: bigint;
  /** Launchpad address used to label the "Launchpad" curve holder. */
  launchpadAddress?: Address;
}

type Tab = "transactions" | "holders";

/**
 * Tabbed panel sitting under the price chart on the token detail page.
 *   - Transactions (default): live trade feed (buys/sells) with WebSocket
 *     updates pushed in at the top.
 *   - Holders: top wallet holdings with a visual distribution bar.
 */
export function TokenActivityPanel({ token, symbol, mode, pool, totalSupplyRaw, launchpadAddress }: Props) {
  const [tab, setTab] = useState<Tab>("transactions");

  return (
    <div className="arc-card p-5">
      <div className="mb-4 flex items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1">
        <TabButton active={tab === "transactions"} onClick={() => setTab("transactions")}>
          <Activity className="h-3.5 w-3.5" /> Transactions
        </TabButton>
        <TabButton active={tab === "holders"} onClick={() => setTab("holders")}>
          <Users className="h-3.5 w-3.5" /> Holders
        </TabButton>
      </div>
      {tab === "transactions" ? (
        <TransactionsTab token={token} symbol={symbol} mode={mode} pool={pool} launchpadAddress={launchpadAddress} />
      ) : (
        <HoldersTab token={token} totalSupplyRaw={totalSupplyRaw} launchpadAddress={launchpadAddress} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
        active
          ? "bg-arc-cta-hover text-white"
          : "text-arc-text-muted hover:text-arc-text",
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------ Transactions ------------------------------ */

function TransactionsTab({
  token,
  symbol,
  mode,
  pool,
  launchpadAddress,
}: {
  token: Address;
  symbol: string;
  mode?: number;
  pool?: Address;
  launchpadAddress?: Address;
}) {
  const { trades, isLoading } = useTokenTrades({ token, mode, pool, launchpad: launchpadAddress });
  const explorerUrl = arcTestnet.blockExplorers?.default.url ?? "https://testnet.arcscan.app";

  if (isLoading && trades.length === 0) {
    return (
      <div className="space-y-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded-lg bg-arc-bg-elevated/60" />
        ))}
      </div>
    );
  }
  if (trades.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-arc-text-muted">
        No trades yet. Live feed will populate as soon as the first one lands.
      </div>
    );
  }

  return (
    // Audit 2026-06-18b responsive: the row grid has ~400px of fixed
    // columns. The old `overflow-hidden` CLIPPED those columns on a
    // 360px viewport (the Time / chevron columns vanished). Switch to
    // horizontal scroll with a shared min-width so the table scrolls as
    // a unit on mobile — the standard table-on-mobile pattern. Desktop
    // is unaffected (min-w sits below the card width).
    <div className="overflow-x-auto">
      <div className="min-w-[440px]">
        <div className="grid grid-cols-[60px_minmax(0,1fr)_100px_100px_80px_20px] gap-2 border-b border-arc-border pb-2 text-[10px] uppercase tracking-wider text-arc-text-faint">
          <div>Type</div>
          <div>Wallet</div>
          <div className="text-right">USDC</div>
          <div className="text-right">{symbol}</div>
          <div className="text-right">Time</div>
          <div />
        </div>
        <div className="max-h-[420px] divide-y divide-arc-border/40 overflow-y-auto">
          {trades.map((t) => (
            <TradeRow key={t.txHash} trade={t} symbol={symbol} explorerUrl={explorerUrl} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TradeRow({
  trade,
  symbol,
  explorerUrl,
}: {
  trade: Trade;
  symbol: string;
  explorerUrl: string;
}) {
  const isBuy = trade.type === "buy";
  // Arc has ~1s blocks; the conversion is approximate but good enough for the feed.
  const seconds = trade.blocksAgo;
  return (
    <div className="grid grid-cols-[60px_minmax(0,1fr)_100px_100px_80px_20px] items-center gap-2 px-1 py-2 text-xs tabular-nums">
      <span
        className={cn(
          "rounded-md px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase",
          isBuy
            ? "bg-arc-success/15 text-arc-success"
            : "bg-arc-danger/15 text-arc-danger",
        )}
      >
        {isBuy ? "Buy" : "Sell"}
      </span>
      <a
        href={`${explorerUrl}/address/${trade.wallet}`}
        target="_blank"
        rel="noopener noreferrer"
        className="truncate font-mono text-[11px] text-arc-text-muted hover:text-arc-text"
      >
        {formatAddress(trade.wallet)}
      </a>
      <span className="text-right">{formatUSDC(trade.usdcRaw, 6, 2)}</span>
      <span className="text-right text-arc-text-muted">
        {formatToken(trade.tokenRaw, 18, 0)}
      </span>
      <span className="text-right text-[10px] text-arc-text-faint">
        {fmtAgo(seconds)}
      </span>
      <a
        href={`${explorerUrl}/tx/${trade.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="View transaction"
        className="text-arc-text-faint hover:text-arc-cta-hover"
      >
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function fmtAgo(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/* --------------------------------- Holders -------------------------------- */

function HoldersTab({
  token,
  totalSupplyRaw,
  launchpadAddress,
}: {
  token: Address;
  totalSupplyRaw: bigint;
  launchpadAddress?: Address;
}) {
  const { holders, isLoading } = useTokenHolders(token, totalSupplyRaw);
  const explorerUrl = arcTestnet.blockExplorers?.default.url ?? "https://testnet.arcscan.app";
  const lpAddr = (launchpadAddress ?? ADDRESSES.launchpad).toLowerCase();
  const DEAD = "0x000000000000000000000000000000000000dead";

  const { topHolders, distribution } = useMemo(() => {
    // Top 10 by balance, with a small "Others" rollup line for the distribution bar.
    const TOP = 10;
    const top = holders.slice(0, TOP);
    const restPct = holders.slice(TOP).reduce((acc, h) => acc + h.pctOfSupply, 0);
    return {
      topHolders: top,
      distribution: { top, restPct },
    };
  }, [holders]);

  if (isLoading && holders.length === 0) {
    return (
      <div className="space-y-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded-lg bg-arc-bg-elevated/60" />
        ))}
      </div>
    );
  }
  if (holders.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-arc-text-muted">
        No holders yet.
      </div>
    );
  }

  return (
    <div>
      {/* Distribution bar (stacked segments coloured by holder rank). */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-arc-text-muted">
          <span>Distribution (top 10)</span>
          <span>{holders.length} unique holders</span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-arc-bg-elevated">
          {distribution.top.map((h, i) => (
            <div
              key={h.address}
              style={{
                width: `${Math.max(h.pctOfSupply, 0.5)}%`,
                background: holderColor(i),
              }}
              title={`${formatAddress(h.address)} - ${h.pctOfSupply.toFixed(2)}%`}
            />
          ))}
          {distribution.restPct > 0 && (
            <div
              style={{ width: `${distribution.restPct}%`, background: "rgba(146, 168, 194, 0.35)" }}
              title={`Others - ${distribution.restPct.toFixed(2)}%`}
            />
          )}
        </div>
      </div>

      {/* Header */}
      <div className="grid grid-cols-[20px_minmax(0,1fr)_110px_60px_20px] gap-2 border-b border-arc-border pb-2 text-[10px] uppercase tracking-wider text-arc-text-faint">
        <div>#</div>
        <div>Wallet</div>
        <div className="text-right">Balance</div>
        <div className="text-right">%</div>
        <div />
      </div>

      <div className="max-h-[420px] divide-y divide-arc-border/40 overflow-y-auto">
        {topHolders.map((h, i) => {
          const isLp = h.address.toLowerCase() === lpAddr;
          const isDead = h.address.toLowerCase() === DEAD;
          const label = isLp
            ? "Launchpad (curve / treasury)"
            : isDead
              ? "Burned LP (dead)"
              : formatAddress(h.address);
          return (
            <div
              key={h.address}
              className="grid grid-cols-[20px_minmax(0,1fr)_110px_60px_20px] items-center gap-2 px-1 py-2 text-xs tabular-nums"
            >
              <span className="text-[10px] text-arc-text-faint">{i + 1}</span>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: holderColor(i) }}
                  aria-hidden
                />
                <a
                  href={`${explorerUrl}/address/${h.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "truncate text-[11px] hover:text-arc-text",
                    isLp || isDead
                      ? "text-arc-text-faint"
                      : "font-mono text-arc-text-muted",
                  )}
                >
                  {label}
                </a>
              </div>
              <span className="text-right">{formatToken(h.balanceRaw, 18, 0)}</span>
              <span className="text-right text-arc-text-muted">{h.pctOfSupply.toFixed(2)}%</span>
              <a
                href={`${explorerUrl}/address/${h.address}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View on explorer"
                className="text-arc-text-faint hover:text-arc-cta-hover"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const HOLDER_PALETTE = [
  "#15508F", // arc-cta-hover
  "#22c55e", // green
  "#f59e0b", // amber
  "#7c5cfc", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#42729a", // arc-primary-hover
  "#84cc16", // lime
  "#f97316", // orange
  "#a78bfa", // violet
] as const;

function holderColor(i: number): string {
  return HOLDER_PALETTE[i % HOLDER_PALETTE.length];
}
