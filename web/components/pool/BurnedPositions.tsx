"use client";

import { Flame, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Address } from "viem";
import { useReadContracts } from "wagmi";
import { PAIR_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useLaunchpadTokens } from "@/lib/hooks/useLaunchpadTokens";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { formatUSDC, formatToken } from "@/lib/utils";

const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;

/**
 * Lists pools whose LP has been burned. These come from launchpad migrations:
 * once a token's bonding curve completes, the launchpad seeds a V2 pair with
 * the collected USDC + 200M tokens and sends all LP to `0xdead`, locking
 * liquidity forever.
 */
export function BurnedPositions() {
  const { tokens, isLoading } = useLaunchpadTokens();

  const migrated = useMemo(() => tokens.filter((t) => t.migrated), [tokens]);

  const pairData = useReadContracts({
    contracts: migrated.flatMap((t) => [
      { address: t.v2Pair, abi: PAIR_ABI, functionName: "token0" },
      { address: t.v2Pair, abi: PAIR_ABI, functionName: "getReserves" },
      { address: t.v2Pair, abi: PAIR_ABI, functionName: "totalSupply" },
      { address: t.v2Pair, abi: PAIR_ABI, functionName: "balanceOf", args: [DEAD] },
    ]),
    query: { enabled: migrated.length > 0 },
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="arc-card h-32 animate-pulse" />
        ))}
      </div>
    );
  }

  if (migrated.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-arc-border bg-arc-bg-elevated py-16 text-center">
        <Flame className="mx-auto mb-3 h-10 w-10 text-arc-text-faint" />
        <p className="text-sm text-arc-text-muted">
          No burned pools yet. They appear here once a launchpad token migrates to the DEX.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {migrated.map((t, i) => {
        const token0 = pairData.data?.[4 * i]?.result as Address | undefined;
        const reserves = pairData.data?.[4 * i + 1]?.result as [bigint, bigint, number] | undefined;
        const totalSupply = (pairData.data?.[4 * i + 2]?.result as bigint | undefined) ?? 0n;
        const deadBalance = (pairData.data?.[4 * i + 3]?.result as bigint | undefined) ?? 0n;
        const burnPct =
          totalSupply > 0n ? Number((deadBalance * 10000n) / totalSupply) / 100 : 0;
        const isToken0Usdc = token0 && token0.toLowerCase() === ADDRESSES.usdc.toLowerCase();
        const usdcReserve = !reserves
          ? 0n
          : isToken0Usdc
            ? reserves[0]
            : reserves[1];
        const tokenReserve = !reserves
          ? 0n
          : isToken0Usdc
            ? reserves[1]
            : reserves[0];
        // TVL = 2 * usdc side (since both sides are equal in value in a V2 pool)
        const tvl = usdcReserve * 2n;
        return (
          <Link
            key={t.address}
            href={`/launchpad/${t.address}`}
            className="arc-card group p-5 transition-colors hover:border-arc-border-strong"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex -space-x-2">
                  <TokenIcon symbol={t.symbol} size={36} />
                  <TokenIcon symbol="USDC" size={36} className="ring-2 ring-arc-bg-elevated" />
                </div>
                <div>
                  <div className="font-semibold">
                    {t.symbol ?? "?"} / USDC
                  </div>
                  <div className="text-xs text-arc-text-muted">{t.name ?? "-"}</div>
                </div>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-arc-warn/30 bg-arc-warn/10 px-2 py-0.5 text-[10px] font-medium text-arc-warn">
                <Flame className="h-3 w-3" /> LP burned
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Stat label="TVL" value={`$${formatUSDC(tvl, USDC_DECIMALS, 0)}`} />
              <Stat label="USDC" value={formatUSDC(usdcReserve, USDC_DECIMALS, 0)} />
              <Stat label={t.symbol ?? "TOKEN"} value={formatToken(tokenReserve, 18, 0)} />
            </div>
            <div className="mt-3 flex items-center justify-between text-[11px] text-arc-text-faint">
              <span>Burn {burnPct.toFixed(2)}% to dead</span>
              <span className="inline-flex items-center gap-1 group-hover:text-arc-text">
                View token <ExternalLink className="h-3 w-3" />
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-arc-border bg-arc-bg-elevated p-2">
      <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">{label}</div>
      <div className="mt-0.5 truncate tabular-nums text-sm text-arc-text">{value}</div>
    </div>
  );
}
