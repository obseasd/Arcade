"use client";

import { useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { FACTORY_ABI, PAIR_ABI, ROUTER_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { formatToken, formatUSDC } from "@/lib/utils";

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

export function MyPositions({ emptyState }: { emptyState?: React.ReactNode } = {}) {
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
      (pairAddrs.data ?? [])
        .map((c) => (c.status === "success" ? (c.result as unknown as Address) : undefined))
        .filter(Boolean) as Address[],
    [pairAddrs.data],
  );

  // For each pair, fetch token0/token1/reserves/totalSupply/userLpBalance
  const pairData = useReadContracts({
    contracts: account
      ? pairs.flatMap((p) => [
          { address: p, abi: PAIR_ABI, functionName: "token0" },
          { address: p, abi: PAIR_ABI, functionName: "token1" },
          { address: p, abi: PAIR_ABI, functionName: "getReserves" },
          { address: p, abi: PAIR_ABI, functionName: "totalSupply" },
          { address: p, abi: PAIR_ABI, functionName: "balanceOf", args: [account] },
        ])
      : [],
    query: { enabled: !!account && pairs.length > 0 },
  });

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

  return (
    <div className="space-y-4">
      {positions.map((p) => (
        <PositionRow
          key={p.pair}
          position={p}
          expanded={openPair === p.pair}
          onToggle={() => setOpenPair(openPair === p.pair ? null : p.pair)}
          onRefresh={() => pairData.refetch()}
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
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  const sharePct = (Number(p.lpBalance) / Number(p.lpTotal)) * 100;
  const amt0 = (p.reserve0 * p.lpBalance) / p.lpTotal;
  const amt1 = (p.reserve1 * p.lpBalance) / p.lpTotal;

  const lpToRemove = (p.lpBalance * BigInt(pct)) / 100n;
  const min0 = ((amt0 * BigInt(pct)) / 100n * 99n) / 100n;
  const min1 = ((amt1 * BigInt(pct)) / 100n * 99n) / 100n;

  const { ensureAllowance } = useApproveIfNeeded(p.pair, ADDRESSES.router);

  const onRemove = async () => {
    if (!account || pct === 0) return;
    try {
      setTx({ status: "pending", message: "Approving LP tokens…" });
      await ensureAllowance(lpToRemove);
      setTx({ status: "pending", message: "Removing liquidity…" });
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
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      setTx({ status: "success", message: "Liquidity removed" });
      onRefresh();
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Failed" });
    }
  };

  const fmt = (b: bigint, dec: number) =>
    dec === USDC_DECIMALS ? formatUSDC(b, dec, 2) : formatToken(b, dec, 4);

  return (
    <div className="arc-card overflow-hidden">
      <button onClick={onToggle} className="flex w-full items-center justify-between p-4 hover:bg-arc-surface">
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            <TokenIcon symbol={p.symbol0} size={32} />
            <TokenIcon symbol={p.symbol1} size={32} className="ring-2 ring-arc-surface" />
          </div>
          <div className="text-left">
            <div className="font-medium">
              {p.symbol0} / {p.symbol1}
            </div>
            <div className="text-xs text-arc-text-muted">Share: {sharePct.toFixed(4)}%</div>
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="text-arc-text-muted">Underlying</div>
          <div className="tabular-nums">
            {fmt(amt0, p.decimals0)} {p.symbol0} · {fmt(amt1, p.decimals1)} {p.symbol1}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-arc-border bg-arc-bg-elevated p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>Remove</span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={pct}
            onChange={(e) => setPct(Number(e.target.value))}
            className="w-full accent-arc-primary"
          />
          <div className="mt-2 flex gap-2">
            {[25, 50, 75, 100].map((v) => (
              <button
                key={v}
                onClick={() => setPct(v)}
                className="flex-1 rounded-lg border border-arc-border bg-arc-surface py-1 text-xs hover:bg-arc-surface-2"
              >
                {v}%
              </button>
            ))}
          </div>
          <div className="mt-3 text-xs text-arc-text-muted">
            You will receive (≥99%):
            <div className="mt-1 tabular-nums text-arc-text">
              {fmt(min0, p.decimals0)} {p.symbol0} + {fmt(min1, p.decimals1)} {p.symbol1}
            </div>
          </div>
          <button onClick={onRemove} className="arc-button-secondary mt-3 w-full py-2 text-sm" disabled={tx.status === "pending"}>
            {tx.status === "pending" ? "Removing…" : "Remove liquidity"}
          </button>
          <TxStatus state={tx} className="mt-2" />
        </div>
      )}
    </div>
  );
}
