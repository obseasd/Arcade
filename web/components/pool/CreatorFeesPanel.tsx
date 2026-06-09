"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Address, erc20Abi, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { useV3Volume24h } from "@/lib/hooks/useV3Volume24h";
import { TokenIcon } from "@/components/ui/TokenIcon";
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
 * per position with logos + 24h swap volume.
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

  // Recipients per position for ownership filtering.
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
      {mine.map((p) => (
        <PositionRow key={p.token} position={p} />
      ))}
    </div>
  );
}

/* --------------------------------- Row UI --------------------------------- */

function PositionRow({ position }: { position: CreatorPosition }) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { address: account } = useAccount();
  const queryClient = useQueryClient();
  const [claiming, setClaiming] = useState(false);

  // Real logo from the creator's uploaded metadata.
  const { image } = useTokenImage(position.token);

  // Pending fees on this position (paired + clanker side).
  const previewQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "previewFees",
    args: [position.positionId],
    query: { enabled: position.positionId > 0n, refetchInterval: 15_000 },
  });
  // Position metadata: paired token address + pool for the 24h volume.
  const posQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "getPosition",
    args: [position.positionId],
    query: { enabled: position.positionId > 0n },
  });
  const pairedToken = posQ.data?.pairedToken as Address | undefined;
  const pool = posQ.data?.pool as Address | undefined;

  const pairedMeta = usePairedTokenMeta(pairedToken);
  const { volume: vol24h } = useV3Volume24h(pool);
  const pairedRaw = (previewQ.data?.[0] ?? 0n) as bigint;
  const clankerRaw = (previewQ.data?.[1] ?? 0n) as bigint;
  const hasFees = pairedRaw > 0n || clankerRaw > 0n;

  const claim = async () => {
    setClaiming(true);
    // Snapshot the previewed amounts BEFORE the claim so the success toast
    // can show what was actually received. collectFees drains the position,
    // so reading previewQ after the receipt would just print zeros.
    const snapPaired = pairedRaw;
    const snapClanker = clankerRaw;
    const snapPairedSymbol = pairedMeta.symbol ?? "?";
    const snapPairedDecimals = pairedMeta.decimals;
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.v3Locker,
        abi: V3_LOCKER_ABI,
        functionName: "collectFees",
        args: [position.positionId],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      const isUsdc = snapPairedSymbol === "USDC" || snapPairedSymbol === "EURC";
      const pairedFmt = isUsdc
        ? `${formatUSDC(snapPaired, snapPairedDecimals, 4)} ${snapPairedSymbol}`
        : `${formatToken(snapPaired, snapPairedDecimals, 6)} ${snapPairedSymbol}`;
      const clankerFmt = `${formatToken(snapClanker, 18, 6)} ${position.symbol ?? "TOKEN"}`;
      const parts: string[] = [];
      if (snapPaired > 0n) parts.push(pairedFmt);
      if (snapClanker > 0n) parts.push(clankerFmt);
      pushToast({
        kind: "info",
        title: "Fees claimed",
        message: parts.length > 0
          ? `Received ${parts.join(" + ")}`
          : `${position.symbol ?? "Token"} creator fees sent to your wallet`,
      });
      previewQ.refetch();
      // Force the all-time Creator Earnings card to re-scan now so the
      // CLAIMED counter picks up the new RecipientPaid event without
      // waiting 5 min for the staleTime to expire.
      queryClient.invalidateQueries({
        queryKey: ["arcade", "creator-earnings-scan", account?.toLowerCase() ?? null],
      });
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
        <div className="flex shrink-0 items-center gap-3">
          <Volume24h volume={vol24h} />
          <button type="button"
            onClick={claim}
            disabled={claiming || !hasFees}
            className={cn(
              "arc-button-primary px-4 py-2 text-sm",
              (claiming || !hasFees) && "opacity-60",
            )}
          >
            {claiming ? "Claiming…" : hasFees ? "Claim fees" : "No fees yet"}
          </button>
        </div>
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
          tokenImage={image}
        />
      </div>
    </div>
  );
}

function Volume24h({ volume }: { volume: bigint | undefined }) {
  const value =
    volume === undefined
      ? "-"
      : volume === 0n
        ? "$0"
        : `$${formatUSDC(volume, USDC_DECIMALS, 0)}`;
  return (
    <div className="text-right leading-tight">
      <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">24h vol</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function FeeStat({
  label,
  symbol,
  amount,
  decimals,
  tokenImage,
}: {
  label: string;
  symbol?: string;
  amount: bigint;
  decimals: number;
  tokenImage?: string;
}) {
  const formatted =
    decimals === USDC_DECIMALS && (symbol === "USDC" || symbol === "EURC")
      ? formatUSDC(amount, decimals, 4)
      : formatToken(amount, decimals, 6);
  return (
    <div className="rounded-lg border border-arc-border bg-black/30 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <TokenIcon symbol={symbol} image={tokenImage} size={16} />
        <span className="truncate font-medium tabular-nums">{formatted}</span>
        <span className="text-arc-text-muted">{symbol ?? "-"}</span>
      </div>
    </div>
  );
}

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
