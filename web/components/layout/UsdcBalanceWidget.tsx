"use client";

import { erc20Abi } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { formatUSDC } from "@/lib/utils";

/**
 * Compact USDC balance chip shown in the navbar. Displays the user's USDC
 * balance and the USD value (1:1 since USDC is the unit).
 */
export function UsdcBalanceWidget() {
  const { address } = useAccount();
  const balanceQ = useReadContract({
    address: ADDRESSES.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  if (!address) return null;

  const raw = (balanceQ.data as bigint | undefined) ?? 0n;
  const amount = formatUSDC(raw, USDC_DECIMALS, 2);
  const usd = formatUSDC(raw, USDC_DECIMALS, 2);

  return (
    <div className="hidden items-center gap-2 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-1.5 md:flex">
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-arc-primary to-arc-cta">
        <span className="text-[10px] font-bold text-white">$</span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="tabular-nums text-sm font-medium text-arc-text">{amount}</span>
        <span className="text-[10px] text-arc-text-muted">${usd}</span>
      </div>
    </div>
  );
}
