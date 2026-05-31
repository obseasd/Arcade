"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { LAUNCHPAD_TOKEN_DECIMALS, USDC_DECIMALS } from "@/lib/constants";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import type { HoldingInfo } from "@/lib/hooks/useMyHoldings";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { cn, formatAddress } from "@/lib/utils";

/**
 * Card variant used in MyTokens > "Held by you". Different shape from the
 * launchpad TokenCard - here the focus is the user's balance + USD value,
 * not the launch state. Click-through goes to the token detail page.
 */
export function HoldingCard({ holding }: { holding: HoldingInfo }) {
    const { token, balance, valueUsdcRaw } = holding;
    const { image } = useTokenImage(token.address);

    const balanceWhole = Number(formatUnits(balance, LAUNCHPAD_TOKEN_DECIMALS));
    const valueUsd =
        valueUsdcRaw !== undefined
            ? Number(formatUnits(valueUsdcRaw, USDC_DECIMALS))
            : undefined;

    return (
        <Link
            href={`/launchpad/${token.address}`}
            className={cn(
                "arc-card flex items-center gap-3 p-4 transition-colors hover:border-arc-primary/40",
            )}
        >
            <TokenIcon image={image} symbol={token.symbol ?? ""} size={44} />
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                    <div className="truncate text-sm font-semibold">
                        {token.name ?? "Unnamed"}
                    </div>
                    <div className="text-xs text-arc-text-muted">{token.symbol ?? ""}</div>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-arc-text-faint">
                    {formatAddress(token.address)}
                </div>
            </div>
            <div className="text-right">
                <div className="text-sm font-medium">
                    {balanceWhole.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                    <span className="text-xs text-arc-text-muted">{token.symbol ?? ""}</span>
                </div>
                <div className="mt-0.5 text-xs text-arc-text-muted">
                    {valueUsd !== undefined
                        ? `$${valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                        : "-"}
                </div>
            </div>
        </Link>
    );
}
