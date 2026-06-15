"use client";

import { MinusIcon, PlusIcon } from "@/components/ui/MaskIcon";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { FACTORY_ABI, PAIR_ABI, ROUTER_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { cn, formatLpBalance, formatToken, formatUSDC } from "@/lib/utils";

const USDC_LOWER = ADDRESSES.usdc.toLowerCase();

// TxStatus / TxState are no longer used here - feedback now lives in the
// bottom-right toaster (matches the add-liquidity flow).

interface PositionInfo {
  pair: Address;
  token0: Address;
  token1: Address;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  reserve0: bigint;
  reserve1: bigint;
  lpTotal: bigint;
  lpBalance: bigint;
}

export function MyPositions({
  emptyState,
  search = "",
  onCountChange,
}: {
  emptyState?: React.ReactNode;
  search?: string;
  /** Fires whenever the user's position list size changes. The parent
   *  uses it to gate the toolbar + Claim All Fees CTA so an empty list
   *  doesn't surface controls that have nothing to act on. */
  onCountChange?: (n: number) => void;
} = {}) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const [openPair, setOpenPair] = useState<Address | null>(null);

  // Discover pairs
  const lengthQ = useReadContract({
    address: ADDRESSES.factory,
    abi: FACTORY_ABI,
    functionName: "allPairsLength",
  });
  const count = Number((lengthQ.data as bigint | undefined) ?? 0n);

  const pairAddrs = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: ADDRESSES.factory,
      abi: FACTORY_ABI,
      functionName: "allPairs",
      args: [BigInt(i)],
    })),
    query: { enabled: count > 0 },
  });

  const pairs = useMemo(
    () =>
      (pairAddrs.data ?? []).flatMap((c) =>
        c.status === "success" ? [c.result as unknown as Address] : [],
      ),
    [pairAddrs.data],
  );

  // 2026-06-15 audit HIGH#9 fix: fan out a cheap balanceOf-only multicall
  // FIRST so we know which pairs the wallet actually has LP in, then
  // fetch the full (token0/token1/reserves/totalSupply) tuple ONLY for
  // those. The previous shape read all 5 columns for every pair on the
  // factory regardless of balance, scaling O(factory pair count) instead
  // of O(positions held). ~150 multicalled reads dropped to ~30 + N×4
  // where N is positions held (usually 0-3).
  const balancesOnly = useReadContracts({
    contracts: account
      ? pairs.map((p) => ({
          address: p,
          abi: PAIR_ABI,
          functionName: "balanceOf" as const,
          args: [account] as const,
        }))
      : [],
    query: {
      enabled: !!account && pairs.length > 0,
      // Long staleness so a stationary user does not refetch every
      // remount. Refetched explicitly by the Refresh button.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  });
  const heldPairIndexes = useMemo<number[]>(() => {
    if (!balancesOnly.data) return [];
    const out: number[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const r = balancesOnly.data[i];
      if (r?.status === "success" && (r.result as bigint) > 0n) out.push(i);
    }
    return out;
  }, [balancesOnly.data, pairs.length]);
  const heldPairs = useMemo(
    () => heldPairIndexes.map((i) => pairs[i]),
    [heldPairIndexes, pairs],
  );

  // Now fetch the remaining 4 calls per HELD pair only.
  const pairDetail = useReadContracts({
    contracts: heldPairs.flatMap((p) => [
      { address: p, abi: PAIR_ABI, functionName: "token0" as const },
      { address: p, abi: PAIR_ABI, functionName: "token1" as const },
      { address: p, abi: PAIR_ABI, functionName: "getReserves" as const },
      { address: p, abi: PAIR_ABI, functionName: "totalSupply" as const },
    ]),
    query: {
      enabled: heldPairs.length > 0,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  });

  // Reassemble a single .data array in the legacy 5-call-per-pair shape
  // so the downstream code below (which indexes 5*i + offset for ALL
  // factory pairs) keeps working. Held-pair details are zipped in;
  // un-held pairs surface as undefined entries, which the existing
  // status checks already tolerate.
  const pairData = useMemo<{ data: typeof balancesOnly.data }>(() => {
    if (!balancesOnly.data) return { data: undefined };
    const out: ({ status: "success" | "failure"; result?: unknown } | undefined)[] = [];
    let heldIdx = 0;
    for (let i = 0; i < pairs.length; i++) {
      const has = balancesOnly.data[i]?.status === "success" &&
        (balancesOnly.data[i]?.result as bigint) > 0n;
      if (has && pairDetail.data) {
        out.push(pairDetail.data[heldIdx * 4]);
        out.push(pairDetail.data[heldIdx * 4 + 1]);
        out.push(pairDetail.data[heldIdx * 4 + 2]);
        out.push(pairDetail.data[heldIdx * 4 + 3]);
        out.push(balancesOnly.data[i]);
        heldIdx++;
      } else {
        // 5 undefined slots; downstream status check filters out.
        out.push(undefined, undefined, undefined, undefined, balancesOnly.data[i]);
      }
    }
    return { data: out as typeof balancesOnly.data };
  }, [balancesOnly.data, pairDetail.data, pairs.length]);

  // Collect token0/token1 addresses needing metadata
  const tokenMetaTargets = useMemo(() => {
    if (!pairData.data) return [] as Address[];
    const out: Address[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const t0 = pairData.data[5 * i]?.result as Address | undefined;
      const t1 = pairData.data[5 * i + 1]?.result as Address | undefined;
      if (t0) out.push(t0);
      if (t1) out.push(t1);
    }
    return Array.from(new Set(out));
  }, [pairs, pairData.data]);

  const tokenMeta = useReadContracts({
    contracts: tokenMetaTargets.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "symbol" },
      { address: t, abi: erc20Abi, functionName: "decimals" },
    ]),
    query: { enabled: tokenMetaTargets.length > 0 },
  });

  const tokenInfo = useMemo(() => {
    const m: Record<string, { symbol: string; decimals: number }> = {};
    if (tokenMeta.data) {
      tokenMetaTargets.forEach((addr, i) => {
        m[addr.toLowerCase()] = {
          symbol: (tokenMeta.data?.[2 * i]?.result as string | undefined) ?? "?",
          decimals: (tokenMeta.data?.[2 * i + 1]?.result as number | undefined) ?? 18,
        };
      });
    }
    return m;
  }, [tokenMeta.data, tokenMetaTargets]);

  const positions: PositionInfo[] = useMemo(() => {
    if (!pairData.data) return [];
    const out: PositionInfo[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const t0 = pairData.data[5 * i]?.result as Address | undefined;
      const t1 = pairData.data[5 * i + 1]?.result as Address | undefined;
      const reserves = pairData.data[5 * i + 2]?.result as [bigint, bigint, number] | undefined;
      const lpTotal = pairData.data[5 * i + 3]?.result as bigint | undefined;
      const lpBalance = pairData.data[5 * i + 4]?.result as bigint | undefined;
      if (!t0 || !t1 || !reserves || !lpTotal || lpBalance === undefined) continue;
      if (lpBalance === 0n) continue;
      out.push({
        pair: pairs[i],
        token0: t0,
        token1: t1,
        symbol0: tokenInfo[t0.toLowerCase()]?.symbol ?? "?",
        symbol1: tokenInfo[t1.toLowerCase()]?.symbol ?? "?",
        decimals0: tokenInfo[t0.toLowerCase()]?.decimals ?? 18,
        decimals1: tokenInfo[t1.toLowerCase()]?.decimals ?? 18,
        reserve0: reserves[0],
        reserve1: reserves[1],
        lpTotal,
        lpBalance,
      });
    }
    return out;
  }, [pairs, pairData.data, tokenInfo]);

  // Surface the live count to the parent so the toolbar + Claim All CTA
  // can gate on `count > 0`. Fires whenever positions resolves to a new
  // length; cheap to call.
  useEffect(() => {
    onCountChange?.(positions.length);
  }, [positions.length, onCountChange]);

  if (!account) {
    return (
      emptyState ?? (
        <div className="arc-card p-8 text-center text-arc-text-muted">Connect your wallet to see positions.</div>
      )
    );
  }
  if (pairs.length === 0 || positions.length === 0) {
    return (
      emptyState ?? (
        <div className="arc-card p-8 text-center text-arc-text-muted">
          {pairs.length === 0 ? "No pools exist on this DEX yet." : "You don't have any LP positions."}
        </div>
      )
    );
  }

  const searchLower = search.trim().toLowerCase();
  const filtered = searchLower
    ? positions.filter(
        (p) =>
          p.symbol0.toLowerCase().includes(searchLower) ||
          p.symbol1.toLowerCase().includes(searchLower),
      )
    : positions;

  if (filtered.length === 0) {
    return (
      <div className="arc-card p-8 text-center text-sm text-arc-text-muted">
        No positions match the current search.
      </div>
    );
  }

  return (
    // Card grid - matches the V3 list so both tabs read as one component.
    // The Manage panel expands inline within the card so the grid keeps
    // its row balance regardless of which card is open.
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {filtered.map((p) => (
        <PositionRow
          key={p.pair}
          position={p}
          expanded={openPair === p.pair}
          onToggle={() => setOpenPair(openPair === p.pair ? null : p.pair)}
          onRefresh={() => {
            void balancesOnly.refetch();
            void pairDetail.refetch();
          }}
          publicClient={publicClient}
        />
      ))}
    </div>
  );
}

function PositionRow({
  position: p,
  expanded,
  onToggle,
  onRefresh,
  publicClient,
}: {
  position: PositionInfo;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  publicClient: ReturnType<typeof usePublicClient>;
}) {
  const { address: account } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [pct, setPct] = useState(50);
  // Slippage tolerance in bps: 50 = 0.5%, 100 = 1%, 300 = 3%. Default is
  // 0.5% which is more forgiving than the previous hard-coded 1% and rare
  // to trip on a pair-burn (no swap path => the only race is another LP
  // op touching the same pair in the same block).
  const [slippageBps, setSlippageBps] = useState(50);
  const [removing, setRemoving] = useState(false);

  const sharePct = (Number(p.lpBalance) / Number(p.lpTotal)) * 100;
  const amt0 = (p.reserve0 * p.lpBalance) / p.lpTotal;
  const amt1 = (p.reserve1 * p.lpBalance) / p.lpTotal;

  const lpToRemove = (p.lpBalance * BigInt(pct)) / 100n;
  const slipDen = 10_000n - BigInt(slippageBps);
  const expected0 = (amt0 * BigInt(pct)) / 100n;
  const expected1 = (amt1 * BigInt(pct)) / 100n;
  const min0 = (expected0 * slipDen) / 10_000n;
  const min1 = (expected1 * slipDen) / 10_000n;

  const { ensureAllowance } = useApproveIfNeeded(p.pair, ADDRESSES.router);

  const onRemove = async () => {
    if (!account || pct === 0) return;
    try {
      setRemoving(true);
      await ensureAllowance(lpToRemove);
      const hash = await writeContractAsync({
        address: ADDRESSES.router,
        abi: ROUTER_ABI,
        functionName: "removeLiquidity",
        args: [
          p.token0,
          p.token1,
          lpToRemove,
          min0,
          min1,
          account,
          BigInt(Math.floor(Date.now() / 1000) + 600),
        ],
      });
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(
            `Remove liquidity reverted on-chain (tx ${hash.slice(0, 10)}…). Most likely the slippage min was too tight; bump tolerance and retry.`,
          );
        }
      }
      pushToast({
        kind: "liquidity-removed",
        token0: { address: p.token0, symbol: p.symbol0 },
        token1: { address: p.token1, symbol: p.symbol1 },
        amount0Formatted: fmt(expected0, p.decimals0),
        amount1Formatted: fmt(expected1, p.decimals1),
        poolHref: `/pool/${p.pair}`,
        explorerUrl: `${arcTestnet.blockExplorers?.default.url}/tx/${hash}`,
      });
      onRefresh();
    } catch (e: unknown) {
      // Audit low [31]: deep-walk the viem error chain (cause.reason ->
      // shortMessage -> details -> message) so the surfaced toast carries
      // the same fidelity as the V2 add / zap / V3 mint catch paths. Most
      // common cause on Arc is the slippage min being too tight after
      // someone else moved the reserves between read and exec.
      const o = e as Record<string, unknown> | null;
      const reason =
        o && typeof o === "object"
          ? ((o.cause as Record<string, unknown> | undefined)?.reason as string | undefined) ??
            (o.shortMessage as string | undefined) ??
            (o.details as string | undefined) ??
            (o.message as string | undefined)
          : undefined;
      const msg = reason || (e instanceof Error ? e.message : "Failed");
      pushToast({
        kind: "error",
        title: "Remove liquidity failed",
        message: msg.slice(0, 200),
      });
    } finally {
      setRemoving(false);
    }
  };


  // USD valuation - works when one side is USDC (V2 reserves directly
  // give us the price). Falls back to undefined for exotic non-USDC pairs.
  const t0IsUsdc = p.token0.toLowerCase() === USDC_LOWER;
  const t1IsUsdc = p.token1.toLowerCase() === USDC_LOWER;
  const r0Human = Number(formatUnits(p.reserve0, p.decimals0));
  const r1Human = Number(formatUnits(p.reserve1, p.decimals1));
  const a0Human = Number(formatUnits(amt0, p.decimals0));
  const a1Human = Number(formatUnits(amt1, p.decimals1));
  const usdcPerT0 = t0IsUsdc ? 1 : t1IsUsdc && r0Human > 0 ? r1Human / r0Human : undefined;
  const usdcPerT1 = t1IsUsdc ? 1 : t0IsUsdc && r1Human > 0 ? r0Human / r1Human : undefined;
  const usd0 = usdcPerT0 !== undefined ? a0Human * usdcPerT0 : undefined;
  const usd1 = usdcPerT1 !== undefined ? a1Human * usdcPerT1 : undefined;
  const usdTotal = usd0 !== undefined && usd1 !== undefined ? usd0 + usd1 : undefined;
  const pct0 = usdTotal && usdTotal > 0 && usd0 !== undefined ? (usd0 / usdTotal) * 100 : undefined;
  const pct1 = usdTotal && usdTotal > 0 && usd1 !== undefined ? (usd1 / usdTotal) * 100 : undefined;

  const explorerUrl = arcTestnet.blockExplorers?.default.url ?? "https://testnet.arcscan.app";

  // LP balance render: Hyperswap shows "0" for sub-0.001 balances and
  // surfaces the USD value next to it. Our prior formatLpBalance fell
  // through to scientific for tiny balances which read like a bug for a
  // $46 position whose share is < 1e-6 of the pool's LP supply.
  const lpDisplay = (() => {
    const n = Number(p.lpBalance) / 1e18;
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (n >= 0.001) return n.toFixed(4);
    return "0";
  })();

  void explorerUrl;
  return (
    <div className="arc-card p-4">
      {/* Header: token icons + pair name. Extra vertical breathing room
          above + below the pair name (py-2 on the row, mb-4 below) so the
          card doesn't feel cramped. */}
      <div className="flex items-center gap-3 py-2">
        <div className="flex -space-x-2">
          <TokenIcon symbol={p.symbol0} size={40} />
          <TokenIcon symbol={p.symbol1} size={40} />
        </div>
        <div className="text-base font-semibold text-arc-text">
          {p.symbol0} / {p.symbol1}
        </div>
      </div>

      {/* Pool-level metrics row. APR / 1D Volume / Total TVL placeholders
          until the indexer (ArcLens) ships. */}
      <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">APR</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-arc-text-faint">—</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">1D Volume</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-arc-text-faint">—</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">Total TVL</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-arc-text-faint">—</div>
        </div>
      </div>

      {/* Hyperswap LP info block: total pool tokens with USD value, per-
          token pooled balances, pool share. Reads as a tidy info ladder. */}
      <div className="mt-3 space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-arc-text-muted">Your total pool tokens:</span>
          <span className="tabular-nums">
            <span className="font-semibold text-arc-text">{lpDisplay}</span>
            {usdTotal !== undefined && (
              <span className="ml-1 text-arc-text-muted">({fmtUsd(usdTotal)})</span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-arc-text-muted">Pooled {p.symbol0}:</span>
          <span className="inline-flex items-center gap-1.5 tabular-nums font-semibold text-arc-text">
            {fmt(amt0, p.decimals0)}
            <TokenIcon symbol={p.symbol0} size={16} />
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-arc-text-muted">Pooled {p.symbol1}:</span>
          <span className="inline-flex items-center gap-1.5 tabular-nums font-semibold text-arc-text">
            {fmt(amt1, p.decimals1)}
            <TokenIcon symbol={p.symbol1} size={16} />
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-arc-text-muted">Your pool share:</span>
          <span className="font-semibold tabular-nums text-arc-text">
            {sharePct < 0.01 ? "<0.01%" : `${sharePct.toFixed(2)}%`}
          </span>
        </div>
      </div>

      {/* CTA bar: - Remove (left) | + Add (right). Matches the V3 position
          card and the Hyperswap pattern - destructive action on the left,
          constructive action on the right. */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button"
          onClick={onToggle}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-arc-border bg-white/[0.04] px-3 py-2.5 text-sm font-semibold text-arc-text transition-colors hover:bg-white/[0.08]"
        >
          <MinusIcon size={14} />
          {expanded ? "Hide" : "Remove"}
        </button>
        <Link
          href={`/positions/add?type=amm&t0=${p.token0}&t1=${p.token1}`}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-arc-cta px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-arc-cta-hover"
        >
          <PlusIcon size={14} className="bg-white" />
          Add Liquidity
        </Link>
      </div>

      {/* Remove panel - revealed by Manage. Uses the same slider + chip
          presets + slippage selector as before; just now sits inside the
          new card shell. */}
      {expanded && (
        <div className="mt-3 rounded-xl border border-arc-border bg-arc-bg-elevated/60 p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-semibold">Remove liquidity</span>
            <span className="tabular-nums text-arc-text-muted">{pct}%</span>
          </div>
          <input
            aria-label="Remove liquidity percentage"
            type="range"
            min={1}
            max={100}
            value={pct}
            onChange={(e) => setPct(Number(e.target.value))}
            className="w-full accent-arc-primary"
          />
          <div className="mt-2 flex gap-2">
            {[25, 50, 75, 100].map((v) => (
              <button type="button"
                key={v}
                onClick={() => setPct(v)}
                className={cn(
                  "flex-1 rounded-lg border py-1 text-xs transition-colors",
                  pct === v
                    ? "border-arc-cta-hover bg-arc-cta-hover/15 text-arc-text"
                    : "border-arc-border bg-arc-surface text-arc-text-muted hover:text-arc-text",
                )}
              >
                {v}%
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 text-xs">
            <span className="text-arc-text-muted">Slippage tolerance</span>
            <div className="flex items-center gap-1">
              {[
                { label: "0.5%", bps: 50 },
                { label: "1%", bps: 100 },
                { label: "3%", bps: 300 },
              ].map((opt) => (
                <button type="button"
                  key={opt.bps}
                  onClick={() => setSlippageBps(opt.bps)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors",
                    slippageBps === opt.bps
                      ? "bg-arc-cta text-white"
                      : "bg-arc-surface text-arc-text-muted hover:text-arc-text",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 text-xs text-arc-text-muted">
            You will receive at least{" "}
            <span className="font-semibold text-arc-text">
              {(100 - slippageBps / 100).toFixed(2)}%
            </span>{" "}
            of:
            <div
              className="mt-1 tabular-nums text-arc-text"
              title="Minimum guaranteed by your slippage tolerance. Anything above this lands in your wallet; below it the tx reverts."
            >
              {fmt(expected0, p.decimals0)} {p.symbol0} + {fmt(expected1, p.decimals1)} {p.symbol1}
            </div>
          </div>
          <button type="button"
            onClick={onRemove}
            disabled={removing}
            className={cn(
              "mt-3 w-full rounded-xl py-2.5 text-sm font-semibold transition-colors",
              removing
                ? "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted"
                : "bg-arc-cta text-white hover:bg-arc-cta-hover",
            )}
          >
            {removing ? "Removing…" : "Remove liquidity"}
          </button>
        </div>
      )}
    </div>
  );
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Token-decimals-aware balance formatter. Used by PositionRow. Module-scope
 *  so it's not rebuilt on every row render. */
function fmt(b: bigint, dec: number): string {
  return dec === USDC_DECIMALS ? formatUSDC(b, dec, 2) : formatToken(b, dec, 4);
}
