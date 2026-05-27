"use client";

import { useState } from "react";
import { SwapCard } from "./SwapCard";
import { MultiSwapCard } from "./MultiSwapCard";
import type { SwapTab } from "./SwapTabs";

export function SwapContainer() {
  const [tab, setTab] = useState<SwapTab>("swap");

  // Each card renders its own copy of the tab strip in its header so the
  // tabs visually live inside the card instead of floating above it. Tab
  // state stays here so switching is instant on click.
  return (
    <div className="mx-auto max-w-[490px] px-4 py-20 sm:px-6">
      {tab === "swap" ? (
        <SwapCard tab={tab} onTabChange={setTab} />
      ) : (
        <MultiSwapCard tab={tab} onTabChange={setTab} />
      )}
    </div>
  );
}
