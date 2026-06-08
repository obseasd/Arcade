"use client";

import { Check, Copy } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import { useState } from "react";
import { Address } from "viem";
import { Modal } from "@/components/ui/Modal";
import { pushToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Minimal "Receive" modal: shows the connected wallet's full address with
 * a Copy button and a chainId reminder. Shared between the header wallet
 * dropdown and the /my-tokens portfolio action buttons so both entry
 * points open the same UI.
 *
 * Migrated 2026-06-08 to the shared <Modal> (which now sits on top of
 * native <dialog>), so backdrop click, ESC, and focus trap all behave
 * consistently with every other modal in the app.
 */
interface Props {
    address: Address;
    onClose: () => void;
}

export function ReceiveModal({ address, onClose }: Props) {
    // Brief "copied" affordance on the button itself: icon swaps Copy ->
    // Check + label flips to "Copied!" for 1.4s. Complements the toast so
    // the user gets feedback at the click target as well as in the corner.
    const [justCopied, setJustCopied] = useState(false);
    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(address);
            pushToast({ kind: "info", title: "Address copied" });
            setJustCopied(true);
            window.setTimeout(() => setJustCopied(false), 1400);
        } catch {
            pushToast({ kind: "error", title: "Couldn't copy" });
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            widthClassName="max-w-[360px]"
            backdropClassName="backdrop:bg-black/60 backdrop:backdrop-blur-sm"
        >
            <div className="p-5">
                <div className="flex items-center justify-between">
                    <h2 className="text-base font-semibold text-arc-text">Receive</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-arc-text-faint hover:text-arc-text"
                        aria-label="Close receive modal"
                    >
                        <CrossIcon size={16} />
                    </button>
                </div>
                <p className="mt-1 text-xs text-arc-text-muted">
                    Share this address to receive USDC or tokens on Arc.
                </p>
                <div className="mt-4 break-all rounded-xl border border-arc-border bg-arc-surface px-3 py-3 font-mono text-xs text-arc-text">
                    {address}
                </div>
                <button
                    type="button"
                    onClick={onCopy}
                    className={cn(
                        "mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all",
                        justCopied
                            ? "bg-arc-success text-white"
                            : "arc-button-primary",
                    )}
                >
                    {justCopied ? (
                        <>
                            <Check className="h-4 w-4 animate-copy-pop" />
                            Copied!
                        </>
                    ) : (
                        <>
                            <Copy className="h-4 w-4" />
                            Copy address
                        </>
                    )}
                </button>
                <p className="mt-3 text-[11px] text-arc-text-faint">
                    Always verify you&apos;re on Arc testnet (chainId 5042002) before the sender
                    broadcasts.
                </p>
            </div>
        </Modal>
    );
}
