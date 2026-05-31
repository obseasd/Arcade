"use client";

import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { Address } from "viem";
import { useV4LaunchRegistry } from "@/lib/hooks/useV4LaunchRegistry";

/**
 * Renders inside the swap card when EITHER side of the swap is a V4
 * launch. The legacy MultiSwap aggregator can't route through V4 pools
 * yet, so we explicitly nudge the user to the dedicated V4 swap panel on
 * the token's detail page rather than silently failing or producing a
 * worse route.
 *
 * No-op when V4 is disabled or when neither token is a V4 launch.
 */
export function V4RoutingNotice({
    tokenIn,
    tokenOut,
}: {
    tokenIn?: Address;
    tokenOut?: Address;
}) {
    const { isV4Token } = useV4LaunchRegistry();
    const v4Token = isV4Token(tokenIn) ? tokenIn : isV4Token(tokenOut) ? tokenOut : undefined;
    if (!v4Token) return null;

    return (
        <Link
            href={`/launchpad/v4/${v4Token}`}
            className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-arc-primary/40 bg-arc-primary/10 px-3 py-2.5 text-sm transition-colors hover:bg-arc-primary/20"
        >
            <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-arc-primary" />
                <span>
                    <span className="font-medium text-arc-primary">V4 launch.</span>{" "}
                    <span className="text-arc-text-muted">
                        Use the V4 swap panel for the best route.
                    </span>
                </span>
            </div>
            <ArrowRight className="h-4 w-4 text-arc-primary" />
        </Link>
    );
}
