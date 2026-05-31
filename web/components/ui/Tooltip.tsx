"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
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
 * Hover tooltip that renders via a document-level portal so it escapes
 * every ancestor stacking context. Without the portal a sibling section
 * (eg a card grid below the trigger's card) could paint over the popup
 * even with z-[200] because each card sat in its own stacking layer.
 *
 * Positioning is measured from the trigger's bounding rect every time
 * the popup opens, so scroll / resize keep it anchored.
 */
export function Tooltip({ children, content, side = "top", className }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popupRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  // Position the popup against the trigger's viewport rect every time we
  // open. We measure the popup itself so vertical/horizontal alignment
  // accounts for the popup's own dimensions.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !popupRef.current) return;
    const t = triggerRef.current.getBoundingClientRect();
    const p = popupRef.current.getBoundingClientRect();
    const gap = 8;
    let top = 0;
    let left = 0;
    if (side === "top") {
      top = t.top - p.height - gap;
      left = t.left + t.width / 2 - p.width / 2;
    } else if (side === "bottom") {
      top = t.bottom + gap;
      left = t.left + t.width / 2 - p.width / 2;
    } else if (side === "left") {
      top = t.top + t.height / 2 - p.height / 2;
      left = t.left - p.width - gap;
    } else {
      top = t.top + t.height / 2 - p.height / 2;
      left = t.right + gap;
    }
    // Clamp to the viewport so the popup never gets clipped off-screen
    // when the trigger is near an edge.
    const pad = 8;
    left = Math.max(pad, Math.min(left, window.innerWidth - p.width - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - p.height - pad));
    setPos({ top, left });
  }, [open, side, content]);

  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 80);
  };

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={hideSoon}
      tabIndex={-1}
    >
      {children}
      {open && mounted &&
        createPortal(
          <span
            ref={popupRef}
            role="tooltip"
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? "visible" : "hidden",
            }}
            className={cn(
              "pointer-events-none z-[9999] w-max max-w-xs rounded-md border border-arc-border bg-arc-bg-elevated px-2.5 py-1.5 text-[11px] font-normal leading-snug text-arc-text shadow-arc-card",
              className,
            )}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}
