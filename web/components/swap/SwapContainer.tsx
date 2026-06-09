"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useAccount } from "wagmi";
import { LIMIT_ORDERS_ENABLED } from "@/lib/constants";
import { SwapCard } from "./SwapCard";
import { MultiSwapCard } from "./MultiSwapCard";
import { LimitCard } from "./LimitCard";
import { LimitOrdersPanel } from "./LimitOrdersPanel";
import type { SwapTab } from "./SwapTabs";

function isValidTab(v: string | null): v is SwapTab {
  return v === "swap" || v === "limit" || v === "multi";
}

function SwapContainerInner() {
  const searchParams = useSearchParams();
  // Allow callers like the portfolio More dropdown to deep-link to a
  // specific tab via ?mode=limit. Mapped to "multi" for ?mode=multi.
  const modeParam = searchParams.get("mode");
  const initialTab: SwapTab = isValidTab(modeParam) ? modeParam : "swap";
  const [tab, setTab] = useState<SwapTab>(initialTab);
  const { address: account } = useAccount();

  // Each card renders its own copy of the tab strip in its header so the
  // tabs visually live inside the card instead of floating above it. Tab
  // state stays here so switching is instant on click.
  //
  // py-8 on mobile, py-20 from sm: up so the card doesn't sit behind a
  // giant white gap on small screens.
  //
  // When the Limit tab is active, the LimitOrdersPanel renders twice but
  // only one is visible at a time:
  //   - Inline below the card on screens smaller than xl (lg:hidden trick).
  //   - Floating fixed top-right on xl+ desktops (hidden xl:block).
  // wagmi dedupes the underlying RPC reads by query key so the duplication
  // costs nothing.
  return (
    <>
      <div className="mx-auto max-w-[490px] px-4 py-8 sm:px-6 sm:py-20">
        {tab === "swap" ? (
          <SwapCard tab={tab} onTabChange={setTab} />
        ) : tab === "limit" ? (
          <LimitCard tab={tab} onTabChange={setTab} />
        ) : (
          <MultiSwapCard tab={tab} onTabChange={setTab} />
        )}

        {tab === "limit" && account && LIMIT_ORDERS_ENABLED && (
          <div className="mt-4 xl:hidden">
            <LimitOrdersPanel account={account} variant="card" />
          </div>
        )}
      </div>

      {tab === "limit" && account && LIMIT_ORDERS_ENABLED && (
        // Anchored to the right side of the LimitCard: vertically aligned
        // with the in-card "Swap Limit Multi Token Swap" tabs (~200px from
        // viewport top, matching navbar + container py-20 + card p-6 + tab
        // row center), horizontally placed 24px to the right of the card.
        // The card is 490px wide centered, so panel's right offset is
        // calc(50% - 490/2 - 24 - 360) = calc(50% - 629px) which scales
        // cleanly across xl+ viewports.
        <div
          className="fixed z-30 hidden w-[360px] xl:block"
          style={{ top: 200, right: "calc(50% - 629px)" }}
        >
          <LimitOrdersPanel account={account} variant="floating" />
        </div>
      )}
    </>
  );
}

// useSearchParams requires a Suspense boundary in Next.js app router.
// The fallback renders nothing; the search params are available
// synchronously once mounted so the user sees the right tab on first paint.
export function SwapContainer() {
  return (
    <Suspense fallback={null}>
      <SwapContainerInner />
    </Suspense>
  );
}
