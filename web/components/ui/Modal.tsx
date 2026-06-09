"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Module-level body-scroll lock counter. Stacked modals (e.g. the Send
// modal opens a Token Select sub-modal) all share this state so the
// overflow:hidden is only set on the 0 -> 1 transition and only
// restored on the 1 -> 0 transition. Without this the inner modal
// captures the outer modal's already-applied "hidden" as its
// pre-state and, on close, restores "hidden", leaving the page locked
// after every modal in the stack has unmounted. Audit UI-H-10.
let modalCount = 0;
let savedOverflow: string | undefined;
function acquireBodyLock() {
  if (typeof document === "undefined") return;
  if (modalCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  modalCount += 1;
}
function releaseBodyLock() {
  if (typeof document === "undefined") return;
  modalCount = Math.max(0, modalCount - 1);
  if (modalCount === 0) {
    document.body.style.overflow = savedOverflow ?? "";
    savedOverflow = undefined;
  }
}

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
  const mouseDownOnBackdropRef = useRef(false);

  // Drive open/close imperatively - the only way native <dialog> works.
  // showModal() puts it in the top layer; close() pulls it back out. The
  // body-scroll lock now uses a shared counter (modalCount) so stacked
  // modals (e.g. SendModal -> TokenSelectModal) don't fight over the
  // overflow value - the inner modal would otherwise capture the outer's
  // already-applied "hidden" as `orig` and on close restore "hidden",
  // leaving the page locked. Audit UI-H-10. Mousedown ref also reset on
  // open so an ESC mid-press doesn't leak into the next session
  // (UI-H-9).
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      mouseDownOnBackdropRef.current = false;
      acquireBodyLock();
      return () => {
        releaseBodyLock();
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

  // Backdrop click detection. Native click fires on mouseup, so a user
  // who mousedowns INSIDE the modal to select text and drags outside
  // would otherwise dismiss the modal on release. Track whether the
  // press *started* on the backdrop and require both ends to land there
  // before closing - matches Uniswap / native dialog behaviour.
  const onMouseDown = (e: MouseEvent<HTMLDialogElement>) => {
    mouseDownOnBackdropRef.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (!closeOnBackdrop) return;
    if (
      e.target === e.currentTarget &&
      mouseDownOnBackdropRef.current
    ) {
      onClose();
    }
    mouseDownOnBackdropRef.current = false;
  };

  return (
    <dialog
      ref={dialogRef}
      onClick={onClick}
      onMouseDown={onMouseDown}
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
