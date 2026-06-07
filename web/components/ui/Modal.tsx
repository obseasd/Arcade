"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** If false, clicks on the backdrop will not close the modal. */
  closeOnBackdrop?: boolean;
  /** If false, the ESC key will not close the modal. */
  closeOnEscape?: boolean;
  /** Tailwind max-width class - defaults to `max-w-lg`. Applied to the
   *  dialog itself; the inner card fills it. */
  widthClassName?: string;
  /** Override the ::backdrop styles (browser overlay behind the modal).
   *  Use `backdrop:*` Tailwind variants. */
  backdropClassName?: string;
  /** Inner card class overrides (rounded shell that holds children). */
  className?: string;
  children: ReactNode;
}

/**
 * Generic modal built on top of the native HTML <dialog> element.
 *
 * Before 2026-06-08 this used createPortal + a hand-rolled backdrop div,
 * with manual ESC handling, focus management, and z-index escapes. Native
 * <dialog>.showModal() gets all of that from the browser:
 *
 *   - The dialog enters the top layer, so it's never clipped by an
 *     ancestor `transform`, `filter`, or `overflow:hidden` - that was the
 *     reason for createPortal previously.
 *   - Focus is trapped inside the dialog automatically.
 *   - ESC fires a `cancel` event we re-route to onClose.
 *   - The overlay is the `::backdrop` pseudo-element, styled via
 *     Tailwind's `backdrop:*` variants on the dialog className.
 *   - Backdrop click is detected by `e.target === e.currentTarget`.
 *
 * The body-scroll lock is still hand-rolled because the browser doesn't
 * lock the page scroll itself - we want the underlying page to stay put
 * while the dialog is open.
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
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Drive open/close imperatively - the only way native <dialog> works.
  // showModal() puts it in the top layer; close() pulls it back out. The
  // body-scroll lock and its cleanup live in the same effect so that
  // backdrop-click / ESC closes (which fire onClose -> React rerenders
  // with open=false -> this effect's cleanup runs) always restore the
  // page scroll.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      const orig = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = orig;
        // If the consumer toggled open=false BEFORE the cancel event
        // fired, close() it ourselves. Idempotent: native dialog
        // ignores close() on a not-open dialog.
        if (dlg.open) dlg.close();
      };
    }
    if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // Native <dialog> fires `cancel` on ESC. Re-route to onClose, or
  // preventDefault when the consumer wants ESC ignored.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      if (!closeOnEscape) return;
      onClose();
    };
    dlg.addEventListener("cancel", handleCancel);
    return () => dlg.removeEventListener("cancel", handleCancel);
  }, [closeOnEscape, onClose]);

  // Backdrop click detection. When the user clicks the ::backdrop pseudo,
  // the event's target is the <dialog> itself (because the backdrop
  // technically belongs to the dialog). Clicks inside the inner card
  // target one of its descendants, so `target === currentTarget` is the
  // backdrop-only condition.
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (!closeOnBackdrop) return;
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      onClick={onClick}
      className={cn(
        // <dialog> defaults: position: fixed, browser-centered margins,
        // white background, default border. Reset to a transparent
        // wrapper - the inner card carries the chrome. The my-4/mx-auto
        // top-pin on mobile mirrors the pre-refactor responsive
        // items-start -> sm:items-center behaviour. Override with the
        // widthClassName the caller passed.
        "my-4 mx-auto sm:m-auto",
        "max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)] overflow-y-auto",
        "w-[calc(100vw-2rem)] bg-transparent p-0 outline-none",
        // Native <dialog> defaults `color` to `CanvasText` (system black)
        // and resets the inherited text color from <html>/<body>. Restore
        // the app's text colour explicitly so headings ("Select a token",
        // "Confirm swap", etc.) render in arc-text instead of black.
        "text-arc-text",
        widthClassName,
        backdropClassName ?? "backdrop:bg-black/75 backdrop:backdrop-blur-md",
      )}
      // aria-modal is implicit on a dialog opened with showModal(), but
      // we keep an explicit aria-labelledby slot the caller can use via
      // the children if they need to surface a heading id to assistive
      // tech. Otherwise the inner heading is announced by virtue of
      // being the first focusable text element after the dialog opens.
    >
      <div
        className={cn(
          "w-full overflow-hidden rounded-2xl border border-arc-border bg-arc-bg-elevated shadow-arc-card",
          className,
        )}
      >
        {children}
      </div>
    </dialog>
  );
}
