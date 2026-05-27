"use client";

import { cn } from "@/lib/utils";

export type SwapTab = "swap" | "multi";

interface Props {
  tab: SwapTab;
  onTabChange: (t: SwapTab) => void;
  className?: string;
}

/** Inline tab strip shared by SwapCard and MultiSwapCard. Lives inside the
 * card's own header so the tab visually belongs to the card. */
export function SwapTabs({ tab, onTabChange, className }: Props) {
  return (
    <div className={cn("flex items-center gap-4", className)}>
      <TabButton active={tab === "swap"} onClick={() => onTabChange("swap")}>
        Swap
      </TabButton>
      <TabButton active={tab === "multi"} onClick={() => onTabChange("multi")}>
        Multi Token Swap
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-base font-semibold transition-colors",
        active ? "text-white" : "text-arc-text-faint hover:text-arc-text-muted",
      )}
    >
      {children}
    </button>
  );
}
