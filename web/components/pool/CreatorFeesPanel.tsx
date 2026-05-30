"use client";

import { useMemo, useState } from "react";
import { Address, erc20Abi, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { useTokenMetadataURI } from "@/lib/hooks/useTokenMetadataURI";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { getImageUrl } from "@/lib/metadata";
import { pushToast } from "@/lib/toast";
import { formatToken, formatUSDC, cn } from "@/lib/utils";

interface CreatorPosition {
  token: Address;
  symbol?: string;
  name?: string;
  positionId: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Lists the connected wallet's CLANKER_V3 launches and lets the creator claim
 * their share of accrued LP fees from the locked position. Shows pending fees
 * per position (paired + clanker side) and a running total.
 */
export function CreatorFeesPanel() {
  const { address: account } = useAccount();
  const { tokens: v3Tokens, isLoading } = useV3Tokens();

  // positionId for each V3 token.
  const idCalls = useReadContracts({
    contracts: v3Tokens.map((t) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "positionIdByToken" as const,
      args: [t.address] as const,
    })),
    query: {
      enabled: v3Tokens.length > 0 && ADDRESSES.v3Locker !== ZERO,
    },
  });
  const positionIds = (idCalls.data ?? []).map((c) =>
    c.status === "success" ? (c.result as bigint) : 0n,
  );

  // Recipients per position. Used both for ownership filtering and for the
  // per-position fee share (recipient bps).
  const recCalls = useReadContracts({
    contracts: positionIds.map((id) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "getRecipients" as const,
      args: [id] as const,
    })),
    query: { enabled: positionIds.some((id) => id > 0n) },
  });

  // Keep positions where the connected wallet is a recipient or an admin.
  const mine: CreatorPosition[] = useMemo(() => {
    if (!account || !recCalls.data) return [];
    const acc = account.toLowerCase();
    const out: CreatorPosition[] = [];
    for (let i = 0; i < v3Tokens.length; i++) {
      const r = recCalls.data[i];
      if (r?.status !== "success") continue;
      const recips = r.result as readonly { recipient: Address; admin: Address }[];
      const isMine = recips?.some(
        (x) => x.recipient.toLowerCase() === acc || x.admin.toLowerCase() === acc,
      );
      if (isMine) {
        out.push({
          token: v3Tokens[i].address,
          symbol: v3Tokens[i].symbol,
          name: v3Tokens[i].name,
          positionId: positionIds[i],
        });
      }
    }
    return out;
  }, [account, recCalls.data, v3Tokens, positionIds]);

  if (!account) {
    return (
      <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">
        Connect your wallet to view your creator fees.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">
        Loading your launches…
      </div>
    );
  }
  if (mine.length === 0) {
    return (
      <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">
        You haven&apos;t launched any Clanker V3 tokens yet. They earn you 80% of all swap fees,
        claimable here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-arc-text-muted">
        Your Clanker V3 launches. The locked LP earns you 80% of every swap&apos;s fees (Arcade 20%).
        Claiming sends your share straight to your wallet.
      </p>
      {mine.map((p) => (
        <PositionRow key={p.token} position={p} />
      ))}
      <FeesTotal positions={mine} />
    </div>
  );
}

/* ------------------------------- Row + Total ------------------------------ */

function PositionRow({ position }: { position: CreatorPosition }) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [claiming, setClaiming] = useState(false);

  // Fetch the on-chain metadata URI so we can render the creator's uploaded logo.
  const { metadataURI } = useTokenMetadataURI(position.token);
  const image = getImageUrl(metadataURI ?? "");

  // Pending fees on this position (paired + clanker side).
  const previewQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "previewFees",
    args: [position.positionId],
    query: { enabled: position.positionId > 0n, refetchInterval: 15_000 },
  });
  // Paired token address so we can label and decimals-format the paired amount.
  const posQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "getPosition",
    args: [position.positionId],
    query: { enabled: position.positionId > 0n },
  });
  const pairedToken = posQ.data?.pairedToken as Address | undefined;

  const pairedMeta = usePairedTokenMeta(pairedToken);
  const pairedRaw = (previewQ.data?.[0] ?? 0n) as bigint;
  const clankerRaw = (previewQ.data?.[1] ?? 0n) as bigint;
  const hasFees = pairedRaw > 0n || clankerRaw > 0n;

  const claim = async () => {
    setClaiming(true);
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.v3Locker,
        abi: V3_LOCKER_ABI,
        functionName: "collectFees",
        args: [position.positionId],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      pushToast({
        kind: "info",
        title: "Fees claimed",
        message: `${position.symbol ?? "Token"} creator fees sent to your wallet`,
      });
      previewQ.refetch();
    } catch (e: any) {
      pushToast({ kind: "error", title: "Claim failed", message: e?.shortMessage || e?.message });
    } finally {
      setClaiming(false);
    }
  };

  return (
    <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <TokenIcon symbol={position.symbol} image={image} size={40} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              ${position.symbol ?? "-"}
            </div>
            <div className="truncate text-xs text-arc-text-muted">
              {position.name ?? "Clanker V3 launch"}
            </div>
          </div>
        </div>
        <button
          onClick={claim}
          disabled={claiming || !hasFees}
          className={cn(
            "arc-button-primary shrink-0 px-4 py-2 text-sm",
            (claiming || !hasFees) && "opacity-60",
          )}
        >
          {claiming ? "Claiming…" : hasFees ? "Claim fees" : "No fees yet"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <FeeStat
          label="Paired side"
          symbol={pairedMeta.symbol}
          amount={pairedRaw}
          decimals={pairedMeta.decimals}
        />
        <FeeStat
          label="Token side"
          symbol={position.symbol ?? "TOKEN"}
          amount={clankerRaw}
          decimals={18}
        />
      </div>
    </div>
  );
}

function FeeStat({
  label,
  symbol,
  amount,
  decimals,
}: {
  label: string;
  symbol?: string;
  amount: bigint;
  decimals: number;
}) {
  const formatted =
    decimals === USDC_DECIMALS && (symbol === "USDC" || symbol === "EURC")
      ? formatUSDC(amount, decimals, 4)
      : formatToken(amount, decimals, 6);
  return (
    <div className="rounded-lg border border-arc-border bg-black/30 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">{label}</div>
      <div className="mt-0.5 truncate font-medium tabular-nums">
        {formatted}{" "}
        <span className="text-arc-text-muted">{symbol ?? "-"}</span>
      </div>
    </div>
  );
}

/** Sum pending fees across positions, grouped by paired-token symbol. */
function FeesTotal({ positions }: { positions: CreatorPosition[] }) {
  // Bulk-read previewFees + getPosition for the totals card.
  const previewCalls = useReadContracts({
    contracts: positions.map((p) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "previewFees" as const,
      args: [p.positionId] as const,
    })),
    query: { enabled: positions.length > 0, refetchInterval: 15_000 },
  });
  const posCalls = useReadContracts({
    contracts: positions.map((p) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "getPosition" as const,
      args: [p.positionId] as const,
    })),
    query: { enabled: positions.length > 0 },
  });

  // Group totals by paired-token address (USDC, WETH).
  const pairedTotals = useMemo(() => {
    const map = new Map<string, bigint>();
    if (!previewCalls.data || !posCalls.data) return map;
    for (let i = 0; i < positions.length; i++) {
      const prev = previewCalls.data[i];
      const pos = posCalls.data[i];
      if (prev?.status !== "success" || pos?.status !== "success") continue;
      const paired = (prev.result as readonly [bigint, bigint])[0];
      const pairedAddr = (pos.result as { pairedToken: Address }).pairedToken;
      const key = pairedAddr.toLowerCase();
      map.set(key, (map.get(key) ?? 0n) + paired);
    }
    return map;
  }, [previewCalls.data, posCalls.data, positions]);

  // Resolve symbol/decimals for each paired-token kind we found.
  const pairedAddrs = Array.from(pairedTotals.keys()) as Address[];
  const metaCalls = useReadContracts({
    contracts: pairedAddrs.flatMap((a) => [
      { address: a, abi: erc20Abi, functionName: "symbol" as const },
      { address: a, abi: erc20Abi, functionName: "decimals" as const },
    ]),
    query: { enabled: pairedAddrs.length > 0 },
  });

  if (pairedTotals.size === 0) return null;

  const rows = pairedAddrs.map((addr, i) => {
    const symbol = metaCalls.data?.[2 * i]?.result as string | undefined;
    const decimals = (metaCalls.data?.[2 * i + 1]?.result as number | undefined) ?? 18;
    const total = pairedTotals.get(addr.toLowerCase()) ?? 0n;
    return { addr, symbol, decimals, total };
  });

  const hasAny = rows.some((r) => r.total > 0n);

  return (
    <div className="mt-2 rounded-2xl border border-arc-cta-hover/40 bg-arc-cta-hover/5 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">Total claimable</div>
        <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">
          {positions.length} position{positions.length === 1 ? "" : "s"}
        </div>
      </div>
      {!hasAny && (
        <div className="text-xs text-arc-text-muted">
          No pending fees right now. Totals update every 15s.
        </div>
      )}
      {hasAny && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {rows
            .filter((r) => r.total > 0n)
            .map((r) => (
              <div
                key={r.addr}
                className="flex items-center justify-between rounded-lg border border-arc-border bg-black/30 px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-2">
                  <TokenIcon symbol={r.symbol} size={20} />
                  <span className="text-arc-text-muted">{r.symbol ?? shortAddr(r.addr)}</span>
                </div>
                <div className="font-semibold tabular-nums">
                  {r.decimals === USDC_DECIMALS && (r.symbol === "USDC" || r.symbol === "EURC")
                    ? formatUSDC(r.total, r.decimals, 4)
                    : formatToken(r.total, r.decimals, 6)}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Local helpers ----------------------------- */

/** Fetch symbol + decimals for a paired token. USDC short-circuits to constants. */
function usePairedTokenMeta(addr: Address | undefined): { symbol?: string; decimals: number } {
  const isUsdc = !!addr && addr.toLowerCase() === ADDRESSES.usdc.toLowerCase();
  const calls = useReadContracts({
    contracts:
      addr && addr !== zeroAddress && !isUsdc
        ? [
            { address: addr, abi: erc20Abi, functionName: "symbol" },
            { address: addr, abi: erc20Abi, functionName: "decimals" },
          ]
        : [],
    query: { enabled: !!addr && addr !== zeroAddress && !isUsdc },
  });
  if (isUsdc) return { symbol: "USDC", decimals: USDC_DECIMALS };
  return {
    symbol: calls.data?.[0]?.result as string | undefined,
    decimals: (calls.data?.[1]?.result as number | undefined) ?? 18,
  };
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
