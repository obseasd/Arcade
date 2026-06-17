"use client";

import { Award, Gem, Medal } from "lucide-react";
import type { Address } from "viem";
import { cn } from "@/lib/utils";
import {
    CREATOR_TIER_THRESHOLDS,
    type CreatorTier,
    useCreatorTier,
} from "@/lib/hooks/useCreatorTier";

/**
 * Compact tier badge for a creator address. Counts on-chain bonded
 * launches via `useCreatorTier` and maps the count to one of three
 * tiers (silver / gold / diamond). Renders nothing when the creator is
 * below the silver threshold so a brand-new creator card doesn't
 * spawn an empty placeholder.
 *
 * Tone is matched to the existing arc-* design tokens:
 *   - silver   → arc-text-muted on the surface
 *   - gold     → arc-warn
 *   - diamond  → sky-400 (matches the in-range chip palette)
 *
 * `size="sm"` is the inline-with-the-username variant. `size="lg"` is
 * for headers / profile cards.
 */
interface Props {
    creator: Address | undefined;
    size?: "sm" | "lg";
    className?: string;
}

const TIER_STYLES: Record<
    Exclude<CreatorTier, "none">,
    { wrap: string; icon: React.ComponentType<{ className?: string }> }
> = {
    silver: {
        wrap: "border-arc-border bg-white/[0.03] text-arc-text-muted",
        icon: Medal,
    },
    gold: {
        wrap: "border-arc-warn/40 bg-arc-warn/10 text-arc-warn",
        icon: Award,
    },
    diamond: {
        wrap: "border-sky-400/40 bg-sky-400/10 text-sky-400",
        icon: Gem,
    },
};

export function CreatorTierBadge({ creator, size = "sm", className }: Props) {
    const { tier, bondedCount, isLoading } = useCreatorTier(creator);

    if (isLoading || tier === "none") return null;

    const style = TIER_STYLES[tier];
    const meta = CREATOR_TIER_THRESHOLDS[tier];
    const Icon = style.icon;

    const sm = size === "sm";
    return (
        <span
            title={`${meta.label} — ${bondedCount} bonded launches`}
            className={cn(
                "inline-flex items-center gap-1 rounded-md border font-semibold uppercase tracking-wider",
                style.wrap,
                sm ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs",
                className,
            )}
        >
            <Icon className={sm ? "h-2.5 w-2.5" : "h-3 w-3"} />
            {tier}
        </span>
    );
}
