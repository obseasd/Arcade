"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { LIMIT_ORDERS_ENABLED } from "@/lib/constants";
import { SwapCard } from "./SwapCard";
import { MultiSwapCard } from "./MultiSwapCard";
import { LimitCard } from "./LimitCard";
import { LimitOrdersPanel } from "./LimitOrdersPanel";
import type { SwapTab } from "./SwapTabs";

export function SwapContainer() {
  const [tab, setTab] = useState<SwapTab>("swap");
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
        <div className="fixed right-6 top-28 z-30 hidden w-[360px] xl:block">
          <LimitOrdersPanel account={account} variant="floating" />
        </div>
      )}
    </>
  );
}
