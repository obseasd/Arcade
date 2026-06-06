"use client";

import { useMemo, useState } from "react";
import { Address } from "viem";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { TOKEN_VAULT_ABI } from "@/lib/abis/vault";
import { ADDRESSES } from "@/lib/constants";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { pushToast } from "@/lib/toast";
import { formatToken } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface VestRow {
  token: Address;
  symbol?: string;
  vestId: bigint;
  total: bigint;
  claimed: bigint;
  claimable: bigint;
  lockupEnd: number;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Lists the connected wallet's locked/vesting CLANKER_V3 allocations and lets
 * the recipient claim what has vested.
 */
export function VaultClaimPanel() {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { tokens: v3Tokens, isLoading } = useV3Tokens();
  const { writeContractAsync } = useWriteContract();
  const [claiming, setClaiming] = useState<string | null>(null);

  const vaultSet = ADDRESSES.tokenVault !== ZERO;

  const idCalls = useReadContracts({
    contracts: v3Tokens.map((t) => ({
      address: ADDRESSES.tokenVault,
      abi: TOKEN_VAULT_ABI,
      functionName: "vestIdByToken" as const,
      args: [t.address] as const,
    })),
    query: { enabled: vaultSet && v3Tokens.length > 0 },
  });
  const vestIds = (idCalls.data ?? []).map((c) => (c.status === "success" ? (c.result as bigint) : 0n));

  const vestCalls = useReadContracts({
    contracts: vestIds.map((id) => ({
      address: ADDRESSES.tokenVault,
      abi: TOKEN_VAULT_ABI,
      functionName: "getVest" as const,
      args: [id] as const,
    })),
    query: { enabled: vestIds.some((id) => id > 0n) },
  });
  const claimableCalls = useReadContracts({
    contracts: vestIds.map((id) => ({
      address: ADDRESSES.tokenVault,
      abi: TOKEN_VAULT_ABI,
      functionName: "claimable" as const,
      args: [id] as const,
    })),
    query: { enabled: vestIds.some((id) => id > 0n) },
  });

  const mine: VestRow[] = useMemo(() => {
    if (!account || !vestCalls.data) return [];
    const acc = account.toLowerCase();
    const out: VestRow[] = [];
    for (let i = 0; i < v3Tokens.length; i++) {
      const r = vestCalls.data[i];
      if (r?.status !== "success") continue;
      const v = r.result as {
        recipient: Address;
        total: bigint;
        claimed: bigint;
        lockupEnd: bigint;
        exists: boolean;
      };
      if (!v.exists || v.recipient.toLowerCase() !== acc) continue;
      const cl = claimableCalls.data?.[i];
      out.push({
        token: v3Tokens[i].address,
        symbol: v3Tokens[i].symbol,
        vestId: vestIds[i],
        total: v.total,
        claimed: v.claimed,
        claimable: cl?.status === "success" ? (cl.result as bigint) : 0n,
        lockupEnd: Number(v.lockupEnd),
      });
    }
    return out;
  }, [account, vestCalls.data, claimableCalls.data, v3Tokens, vestIds]);

  const claim = async (row: VestRow) => {
    setClaiming(row.token);
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.tokenVault,
        abi: TOKEN_VAULT_ABI,
        functionName: "claim",
        args: [row.vestId],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "info", title: "Vested tokens claimed", message: `${row.symbol ?? "Token"} sent to your wallet` });
    } catch (e: any) {
      pushToast({ kind: "error", title: "Claim failed", message: e?.shortMessage || e?.message });
    } finally {
      setClaiming(null);
    }
  };

  if (!account)
    return <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">Connect your wallet to view vested allocations.</div>;
  if (isLoading)
    return <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">Loading…</div>;
  if (mine.length === 0)
    return <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">No vesting allocations for this wallet.</div>;

  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="space-y-3">
      {mine.map((row) => {
        const locked = now < row.lockupEnd;
        return (
          <div
            key={row.token}
            className="flex items-center justify-between rounded-2xl border border-arc-border bg-arc-bg-elevated p-4"
          >
            <div className="flex items-center gap-3">
              <TokenIcon symbol={row.symbol} size={36} />
              <div>
                <div className="text-sm font-semibold">{row.symbol ?? "-"}</div>
                <div className="text-xs text-arc-text-muted tabular-nums">
                  {formatToken(row.claimed, 18, 2)} / {formatToken(row.total, 18, 2)} claimed ·{" "}
                  {locked
                    ? `locked until ${new Date(row.lockupEnd * 1000).toLocaleDateString()}`
                    : `${formatToken(row.claimable, 18, 2)} claimable`}
                </div>
              </div>
            </div>
            <button type="button"
              onClick={() => claim(row)}
              disabled={claiming === row.token || row.claimable === 0n}
              className={cn(
                "arc-button-primary px-4 py-2 text-sm",
                (claiming === row.token || row.claimable === 0n) && "opacity-60",
              )}
            >
              {claiming === row.token ? "Claiming…" : "Claim"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
