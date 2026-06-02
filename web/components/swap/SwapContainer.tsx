"use client";

import { useState } from "react";
import { SwapCard } from "./SwapCard";
import { MultiSwapCard } from "./MultiSwapCard";
import { LimitCard } from "./LimitCard";
import type { SwapTab } from "./SwapTabs";

export function SwapContainer() {
  const [tab, setTab] = useState<SwapTab>("swap");

  // Each card renders its own copy of the tab strip in its header so the
  // tabs visually live inside the card instead of floating above it. Tab
  // state stays here so switching is instant on click.
  //
  // py-8 on mobile, py-20 from sm: up so the card doesn't sit behind a
  // giant white gap on small screens.
  return (
    <div className="mx-auto max-w-[490px] px-4 py-8 sm:px-6 sm:py-20">
      {tab === "swap" ? (
        <SwapCard tab={tab} onTabChange={setTab} />
      ) : tab === "limit" ? (
        <LimitCard tab={tab} onTabChange={setTab} />
      ) : (
        <MultiSwapCard tab={tab} onTabChange={setTab} />
      )}
    </div>
  );
}
