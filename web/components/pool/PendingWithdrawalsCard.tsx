"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDownToLine } from "lucide-react";
import { Address, erc20Abi, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { pushToast } from "@/lib/toast";
import { formatToken, formatUSDC, cn } from "@/lib/utils";

/**
 * Pull-payment escape hatch panel. Surfaces any USDC the launchpad has
 * credited to the connected wallet from a failed inline payout (eg the wallet
 * was on the USDC blacklist when a fee transfer fired), plus any V3 locker
 * pending balances across the wallet's recipient slots.
 *
 * Renders nothing if there's nothing to withdraw - this is a safety net, not
 * a normal flow. For 99% of users the card is invisible.
 */
export function PendingWithdrawalsCard() {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { tokens: v3Tokens } = useV3Tokens();
  const [claiming, setClaiming] = useState<string | null>(null);

  // 1) Curve / migrated-trade payout failures live in launchpad's
  //    pendingUsdcWithdrawals[recipient]. Single uint256 in USDC raw units.
  const lpPendingQ = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "pendingUsdcWithdrawals",
    args: account ? [account] : undefined,
    query: { enabled: !!account, refetchInterval: 30_000 },
  });
  const lpPending = (lpPendingQ.data as bigint | undefined) ?? 0n;

  // 2) V3 locker keeps a 2-D ledger token → recipient → amount. For each V3
  //    launch token, the wallet might have a pending paired-side (USDC/WETH)
  //    OR clanker-side balance. We check both token sides per launch.
  const lockerCalls = useReadContracts({
    contracts:
      account && ADDRESSES.v3Locker !== zeroAddress
        ? v3Tokens.flatMap((t) => [
            {
              address: ADDRESSES.v3Locker,
              abi: V3_LOCKER_ABI,
              functionName: "pendingWithdrawals" as const,
              args: [ADDRESSES.usdc, account] as const,
            },
            {
              address: ADDRESSES.v3Locker,
              abi: V3_LOCKER_ABI,
              functionName: "pendingWithdrawals" as const,
              args: [t.address, account] as const,
            },
          ])
        : [],
    query: {
      enabled: !!account && v3Tokens.length > 0 && ADDRESSES.v3Locker !== zeroAddress,
      refetchInterval: 30_000,
    },
  });

  // Dedupe USDC reads: the USDC pending balance is the same regardless of
  // which token row we queried it from. Take the first.
  const lockerUsdcPending = useMemo<bigint>(() => {
    const data = lockerCalls.data;
    if (!data || data.length === 0) return 0n;
    const r = data[0];
    return r?.status === "success" ? (r.result as bigint) : 0n;
  }, [lockerCalls.data]);

  // Per-token side: each v3Token at index i has its clanker-side reading at 2i+1.
  const tokenSidePending = useMemo<Array<{ token: Address; symbol?: string; amount: bigint }>>(() => {
    if (!lockerCalls.data) return [];
    const out: Array<{ token: Address; symbol?: string; amount: bigint }> = [];
    for (let i = 0; i < v3Tokens.length; i++) {
      const r = lockerCalls.data[2 * i + 1];
      if (r?.status !== "success") continue;
      const amount = r.result as bigint;
      if (amount === 0n) continue;
      out.push({ token: v3Tokens[i].address, symbol: v3Tokens[i].symbol, name: v3Tokens[i].name, amount } as any);
    }
    return out;
  }, [lockerCalls.data, v3Tokens]);

  // Bail out cleanly if nothing is owed.
  const totalPending = lpPending + lockerUsdcPending + tokenSidePending.reduce((acc, t) => acc + t.amount, 0n);
  if (!account || totalPending === 0n) return null;

  const claimLaunchpad = async () => {
    setClaiming("launchpad");
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "claimPendingUsdc",
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "info", title: "Pending USDC claimed", message: `${formatUSDC(lpPending, USDC_DECIMALS, 4)} USDC sent` });
      lpPendingQ.refetch();
    } catch (e: any) {
      pushToast({ kind: "error", title: "Claim failed", message: e?.shortMessage || e?.message });
    } finally {
      setClaiming(null);
    }
  };

  const claimLocker = async (token: Address, symbol: string) => {
    setClaiming(`locker:${token.toLowerCase()}`);
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.v3Locker,
        abi: V3_LOCKER_ABI,
        functionName: "withdrawPending",
        args: [token],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "info", title: "Pending balance claimed", message: `${symbol} sent` });
      lockerCalls.refetch();
    } catch (e: any) {
      pushToast({ kind: "error", title: "Claim failed", message: e?.shortMessage || e?.message });
    } finally {
      setClaiming(null);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5">
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
          <AlertTriangle className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-amber-200">Pending withdrawals</h3>
          <p className="mt-0.5 text-xs text-amber-100/70">
            A previous fee payout to your wallet failed inline and was credited
            here. Pull the balance below; if it still fails, check whether your
            address is on the USDC freeze list and try again later.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {lpPending > 0n && (
          <PendingRow
            label="Bonding-curve fees"
            symbol="USDC"
            amount={lpPending}
            decimals={USDC_DECIMALS}
            isUsdcFormat
            onClaim={claimLaunchpad}
            claiming={claiming === "launchpad"}
          />
        )}
        {lockerUsdcPending > 0n && (
          <PendingRow
            label="Clanker V3 LP fees"
            symbol="USDC"
            amount={lockerUsdcPending}
            decimals={USDC_DECIMALS}
            isUsdcFormat
            onClaim={() => claimLocker(ADDRESSES.usdc, "USDC")}
            claiming={claiming === `locker:${ADDRESSES.usdc.toLowerCase()}`}
          />
        )}
        {tokenSidePending.map((t) => (
          <PendingRow
            key={t.token}
            label={`${t.symbol ?? "Token"} side - Clanker LP`}
            symbol={t.symbol ?? "TOKEN"}
            amount={t.amount}
            decimals={18}
            onClaim={() => claimLocker(t.token, t.symbol ?? "TOKEN")}
            claiming={claiming === `locker:${t.token.toLowerCase()}`}
          />
        ))}
      </div>
    </div>
  );
}

function PendingRow({
  label,
  symbol,
  amount,
  decimals,
  isUsdcFormat,
  onClaim,
  claiming,
}: {
  label: string;
  symbol: string;
  amount: bigint;
  decimals: number;
  isUsdcFormat?: boolean;
  onClaim: () => void;
  claiming: boolean;
}) {
  const formatted = isUsdcFormat ? formatUSDC(amount, decimals, 4) : formatToken(amount, decimals, 6);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-black/30 p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <TokenIcon symbol={symbol} size={28} />
        <div className="min-w-0">
          <div className="truncate text-xs text-arc-text-muted">{label}</div>
          <div className="truncate text-sm font-semibold tabular-nums">
            {formatted} <span className="text-arc-text-muted">{symbol}</span>
          </div>
        </div>
      </div>
      <button type="button"
        onClick={onClaim}
        disabled={claiming}
        className={cn(
          "arc-button-primary shrink-0 px-3 py-2 text-xs",
          claiming && "opacity-60",
        )}
      >
        <ArrowDownToLine className="h-3.5 w-3.5" />
        {claiming ? "Claiming…" : "Withdraw"}
      </button>
    </div>
  );
}
