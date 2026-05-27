"use client";

import { useMemo, useState } from "react";
import { Address } from "viem";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { ADDRESSES } from "@/lib/constants";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { pushToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface CreatorPosition {
  token: Address;
  symbol?: string;
  name?: string;
  positionId: bigint;
}

/**
 * Lists the connected wallet's CLANKER_V3 launches and lets the creator claim
 * their 80% share of accrued LP fees from the locked position. Claiming is
 * permissionless on-chain (fees always route to the registered creator), so
 * the button just pokes `collectFees`.
 */
export function CreatorFeesPanel() {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { tokens: v3Tokens, isLoading } = useV3Tokens();
  const { writeContractAsync } = useWriteContract();
  const [claiming, setClaiming] = useState<string | null>(null);

  // positionId for each V3 token
  const idCalls = useReadContracts({
    contracts: v3Tokens.map((t) => ({
      address: ADDRESSES.v3Locker,
      abi: V3_LOCKER_ABI,
      functionName: "positionIdByToken" as const,
      args: [t.address] as const,
    })),
    query: { enabled: v3Tokens.length > 0 && ADDRESSES.v3Locker !== ("0x0000000000000000000000000000000000000000" as Address) },
  });
  const positionIds = (idCalls.data ?? []).map((c) =>
    c.status === "success" ? (c.result as bigint) : 0n,
  );

  // Recipients per position - to check if the connected wallet is one of them
  // (as a payout recipient or an admin).
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

  const claim = async (p: CreatorPosition) => {
    setClaiming(p.token);
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.v3Locker,
        abi: V3_LOCKER_ABI,
        functionName: "collectFees",
        args: [p.positionId],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      pushToast({
        kind: "info",
        title: "Fees claimed",
        message: `${p.symbol ?? "Token"} creator fees sent to your wallet`,
      });
    } catch (e: any) {
      pushToast({ kind: "error", title: "Claim failed", message: e?.shortMessage || e?.message });
    } finally {
      setClaiming(null);
    }
  };

  if (!account) {
    return <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">Connect your wallet to view your creator fees.</div>;
  }
  if (isLoading) {
    return <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">Loading your launches…</div>;
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
        <div
          key={p.token}
          className="flex items-center justify-between rounded-2xl border border-arc-border bg-arc-bg-elevated p-4"
        >
          <div className="flex items-center gap-3">
            <TokenIcon symbol={p.symbol} size={36} />
            <div>
              <div className="text-sm font-semibold">{p.symbol ?? "-"}</div>
              <div className="text-xs text-arc-text-muted">{p.name ?? "Clanker V3 launch"}</div>
            </div>
          </div>
          <button
            onClick={() => claim(p)}
            disabled={claiming === p.token}
            className={cn("arc-button-primary px-4 py-2 text-sm", claiming === p.token && "opacity-60")}
          >
            {claiming === p.token ? "Claiming…" : "Claim fees"}
          </button>
        </div>
      ))}
    </div>
  );
}
