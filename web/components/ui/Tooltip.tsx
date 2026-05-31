"use client";

import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Inline trigger element (the thing the user hovers / focuses). */
  children: React.ReactNode;
  /** Tooltip content. Can be a string or a React node. */
  content: React.ReactNode;
  /** Position relative to the trigger. Default "top". */
  side?: "top" | "bottom" | "left" | "right";
  /** Extra classes on the popup. */
  className?: string;
}

/**
 * Lightweight CSS-only tooltip. Shows on hover or keyboard focus, dismisses
 * after a short delay on mouseleave. No portal, no dependency on a popper
 * library — the popup is absolutely positioned relative to the trigger and
 * keeps a small offset so it doesn't visually touch the underlying element.
 */
export function Tooltip({ children, content, side = "top", className }: Props) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 80);
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={hideSoon}
      tabIndex={-1}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            // z-[200] beats most adjacent stacking contexts so the popup
            // doesn't get visually hidden under sibling cards even when the
            // ancestor card creates a new layer via position:relative.
            // Solid bg avoids see-through artefacts when the tooltip overlaps
            // the card below it.
            "pointer-events-none absolute z-[200] w-max max-w-xs rounded-md border border-arc-border bg-arc-bg-elevated px-2.5 py-1.5 text-[11px] font-normal leading-snug text-arc-text shadow-arc-card",
            side === "top" && "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
            side === "bottom" && "left-1/2 top-full mt-1.5 -translate-x-1/2",
            side === "left" && "right-full top-1/2 mr-1.5 -translate-y-1/2",
            side === "right" && "left-full top-1/2 ml-1.5 -translate-y-1/2",
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
