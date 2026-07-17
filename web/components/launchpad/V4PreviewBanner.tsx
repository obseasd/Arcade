import { FlaskConical } from "lucide-react";

/**
 * Shared "V4 is a preview" notice for the ArcadeHook (/launchpad/v4hook/*) pages.
 *
 * The Uniswap V4 launchpad + hook stack is NOT live on Arc yet: it needs the
 * indexer and mainnet-only pieces (Cancun / EIP-1153) before it can work
 * end to end. These pages render for exploration, but the write flows (pool
 * init, buy/sell) are disabled or non-functional. Surfacing this once, up
 * top, keeps the dead CTAs from reading as broken (pages audit 2026-07-02).
 */
export function V4PreviewBanner() {
    return (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-arc-warn/30 bg-arc-warn/10 p-4 text-sm text-arc-warn">
            <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
                <div className="font-medium">V4 launchpad preview (not live yet)</div>
                <div className="mt-0.5 text-xs text-arc-warn/80">
                    The Uniswap V4 launchpad is a preview on Arc testnet. Pool
                    initialisation and swaps are not wired yet; they ship with
                    the indexer and mainnet rollout. Explore the layout, but the
                    action buttons here are disabled or non-functional for now.
                </div>
            </div>
        </div>
    );
}
