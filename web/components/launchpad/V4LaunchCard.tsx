"use client";

import Link from "next/link";
import { Clock, ShieldCheck, ShieldOff } from "lucide-react";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import type { V4LaunchpadTokenInfo } from "@/lib/hooks/useV4LaunchpadTokens";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { cn, formatAddress, formatRemaining } from "@/lib/utils";

/**
 * Compact V4 launch card for the `/launchpad` main list. Slimmer than the
 * V2/V3 TokenCard because V4 launches don't have the bonding-curve progress
 * bar or migration state - the relevant signals are pool-init status,
 * starting snipe tax, and time remaining in the anti-sniper window.
 */
export function V4LaunchCard({
    token,
    nowSec,
}: {
    token: V4LaunchpadTokenInfo;
    nowSec: bigint;
}) {
    const { image } = useTokenImage(token.address);
    const decayed =
        token.snipeDecaySeconds > 0 &&
        nowSec >= token.launchedAt + BigInt(token.snipeDecaySeconds);
    const remaining = Number(
        token.snipeDecaySeconds > 0 && token.launchedAt + BigInt(token.snipeDecaySeconds) > nowSec
            ? token.launchedAt + BigInt(token.snipeDecaySeconds) - nowSec
            : 0n,
    );

    return (
        <Link
            href={`/launchpad/v4/${token.address}`}
            className="arc-card group flex flex-col gap-3 p-4 transition-colors hover:border-arc-primary/40"
        >
            <div className="flex items-center gap-3">
                <TokenIcon image={image} symbol={token.symbol ?? ""} size={40} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-semibold">
                            {token.name ?? "Unnamed"}
                        </div>
                        <span className="shrink-0 rounded-md border border-arc-primary/40 bg-arc-primary/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-arc-primary">
                            V4
                        </span>
                    </div>
                    <div className="truncate text-xs text-arc-text-muted">
                        {token.symbol ?? ""} · {formatAddress(token.address)}
                    </div>
                </div>
                <span
                    className={cn(
                        "shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider",
                        token.poolInitialized
                            ? "border-arc-success/40 bg-arc-success/10 text-arc-success"
                            : "border-arc-border bg-arc-surface text-arc-text-muted",
                    )}
                >
                    {token.poolInitialized ? "Live" : "Pending"}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-arc-border bg-arc-bg px-2.5 py-1.5">
                    <div className="text-arc-text-muted">Snipe (start)</div>
                    <div className="mt-0.5 font-medium">
                        {(token.snipeStartBps / 100).toFixed(2)}%
                    </div>
                </div>
                <div className="rounded-lg border border-arc-border bg-arc-bg px-2.5 py-1.5">
                    <div className="text-arc-text-muted">Creator alloc</div>
                    <div className="mt-0.5 font-medium">
                        {(token.creatorBps / 100).toFixed(2)}%
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] text-arc-text-muted">
                {decayed || token.snipeStartBps === 0 ? (
                    <>
                        <ShieldOff className="h-3 w-3" />
                        <span>No active snipe tax</span>
                    </>
                ) : (
                    <>
                        <ShieldCheck className="h-3 w-3 text-arc-primary" />
                        <Clock className="h-3 w-3" />
                        <span>{formatRemaining(remaining)} left</span>
                    </>
                )}
            </div>
        </Link>
    );
}

// formatRemaining lives in @/lib/utils now.
