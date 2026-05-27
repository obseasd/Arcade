"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** If false, clicks on the backdrop will not close the modal. */
  closeOnBackdrop?: boolean;
  /** If false, the ESC key will not close the modal. */
  closeOnEscape?: boolean;
  /** Optional max-width class - defaults to `max-w-lg`. */
  widthClassName?: string;
  /** Override the backdrop classes (overlay behind the modal). */
  backdropClassName?: string;
  /** Override the inner card classes. */
  className?: string;
  children: ReactNode;
}

/**
 * Generic modal rendered via React portal into document.body, so it's never
 * clipped by ancestor `transform`, `filter`, or stacking contexts. Click on
 * the backdrop and Escape both close by default.
 */
export function Modal({
  open,
  onClose,
  closeOnBackdrop = true,
  closeOnEscape = true,
  widthClassName = "max-w-lg",
  backdropClassName,
  className,
  children,
}: ModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, closeOnEscape]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const orig = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = orig;
    };
  }, [open]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:items-center",
        backdropClassName ?? "bg-black/75 backdrop-blur-md",
      )}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        className={cn(
          "my-auto w-full overflow-hidden rounded-2xl border border-arc-border bg-arc-bg-elevated shadow-arc-card",
          widthClassName,
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
