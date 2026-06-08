"use client";

import { Wallet, AlertTriangle } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import { useState } from "react";
import { Address, getAddress, isAddress } from "viem";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Current effective recipient (whether default account or override). */
  current?: string;
  /** The connected wallet's own address, used for the "Use my wallet" shortcut. */
  ownAccount?: Address;
  /** Called with the new address, or `null` to clear the override (= revert to connected wallet). */
  onSave: (recipient: Address | null) => void;
  /** Modal heading (defaults to the bridge wording). */
  title?: string;
  /** Explanatory line under the heading. */
  description?: string;
}

export function RecipientEditModal({
  open,
  onClose,
  current,
  ownAccount,
  onSave,
  title = "Recipient address",
  description = "By default, bridged USDC is minted to your connected wallet. You can override the destination address below.",
}: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset on the open=false -> true transition. Render-phase prev-prop
  // check so the input shows the new `current` value on the first paint
  // after open, not the paint after that. `current` is also depended
  // on so the field re-seeds if it changes while the modal stays open
  // (matches the original useEffect dep list).
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevCurrent, setPrevCurrent] = useState(current);
  if (open !== prevOpen || current !== prevCurrent) {
    setPrevOpen(open);
    setPrevCurrent(current);
    if (open) {
      setValue(current ?? "");
      setError(null);
    }
  }

  const onSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      onSave(null);
      onClose();
      return;
    }
    if (!isAddress(trimmed)) {
      setError("Invalid Ethereum address");
      return;
    }
    // Always normalise to EIP-55 checksum on save so an all-lowercase
    // paste from a foreign UI doesn't propagate downstream where some
    // tooling rejects un-checksummed addresses.
    onSave(getAddress(trimmed) as Address);
    onClose();
  };

  // BRIDGE-RECIPIENT-OVERRIDE-NO-CHECKSUM-WARN: surface a soft warning
  // when the input is a valid address but its case doesn't match the
  // EIP-55 checksum. Common XSS / phishing payloads use all-lowercase
  // addresses; the warning gives the user a chance to double-check
  // before signing.
  const checksumMismatch = (() => {
    const trimmed = value.trim();
    if (!trimmed || !isAddress(trimmed)) return false;
    try {
      return getAddress(trimmed) !== trimmed;
    } catch {
      return false;
    }
  })();

  const useOwnWallet = () => {
    onSave(null);
    onClose();
  };

  const isCurrentlyOwn = !!ownAccount && current?.toLowerCase() === ownAccount.toLowerCase();

  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClassName="max-w-md"
      backdropClassName="backdrop:bg-black/30 backdrop:backdrop-blur-sm"
      className="border-arc-border bg-black/45 backdrop-blur-2xl"
    >
      <div className="flex items-center justify-between border-b border-arc-border px-5 py-4">
        <h3 className="text-base font-semibold">{title}</h3>
        <button type="button" onClick={onClose} className="text-arc-text-muted hover:text-arc-text">
          <CrossIcon size={20} />
        </button>
      </div>
      <div className="space-y-4 p-5">
        <p className="text-xs text-arc-text-muted">{description}</p>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Custom recipient</span>
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="0x…"
            className={cn(
              "arc-input w-full rounded-xl border bg-arc-bg px-3 py-2.5 text-sm tabular-nums",
              error ? "border-arc-danger/60" : "border-arc-border",
            )}
          />
          {error && <span className="mt-1 block text-xs text-arc-danger">{error}</span>}
          {!error && checksumMismatch && (
            <span className="mt-1 flex items-center gap-1 text-xs text-arc-warn">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Address case doesn't match its EIP-55 checksum. Double-check the source you copied it from.
            </span>
          )}
        </label>

        {!isCurrentlyOwn && ownAccount && (
          <button type="button"
            onClick={useOwnWallet}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-arc-border bg-arc-surface-2/40 py-2 text-xs text-arc-text-muted hover:bg-arc-surface-3/60"
          >
            <Wallet className="h-3.5 w-3.5" /> Reset to my connected wallet
          </button>
        )}

        <button type="button" onClick={onSubmit} className="arc-button-primary w-full py-3 text-sm">
          Save recipient
        </button>
      </div>
    </Modal>
  );
}
