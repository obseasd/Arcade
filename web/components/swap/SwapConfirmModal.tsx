"use client";

import { X, Loader2 } from "lucide-react";
import Image from "next/image";
import { Modal } from "@/components/ui/Modal";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { type TokenOption } from "@/components/ui/TokenSelectModal";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  tokenIn: TokenOption;
  tokenOut: TokenOption;
  amountInFormatted: string;
  amountOutFormatted: string;
  rateLabel: string;
  guardLabel: string;
  guardKey: string;
  tx: TxState;
}

export function SwapConfirmModal({
  open,
  onClose,
  onConfirm,
  tokenIn,
  tokenOut,
  amountInFormatted,
  amountOutFormatted,
  rateLabel,
  guardLabel,
  guardKey,
  tx,
}: Props) {
  const busy = tx.status === "pending";
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      widthClassName="max-w-md"
      backdropClassName="bg-black/30 backdrop-blur-sm"
      className="border-arc-border bg-black/45 backdrop-blur-2xl"
    >
      <div className="font-sans">
      <div className="flex items-center justify-between border-b border-arc-border px-5 py-4">
        <h3 className="text-base font-semibold">Confirm swap</h3>
        <button
          onClick={onClose}
          disabled={busy}
          className="text-arc-text-muted hover:text-arc-text disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="space-y-3 p-5">
        <SideRow
          label="From"
          symbol={tokenIn.symbol ?? "?"}
          amountFormatted={amountInFormatted}
        />

        <div className="flex justify-center">
          <div className="rounded-xl border border-arc-border bg-arc-surface-2/40 p-2 backdrop-blur-md">
            <Image src="/down.png" alt="" width={16} height={16} className="h-4 w-4 opacity-80" />
          </div>
        </div>

        <SideRow
          label="To"
          symbol={tokenOut.symbol ?? "?"}
          amountFormatted={amountOutFormatted}
        />

        <div className="space-y-1 rounded-xl border border-arc-border bg-arc-bg p-4 text-sm">
          <Row label="Price" value={rateLabel} />
          <Row label={guardKey} value={guardLabel} />
          <Row label="Protocol" value="Arcade V2" />
        </div>

        <button onClick={onConfirm} disabled={busy} className="arc-button-primary w-full py-3.5 text-base">
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {tx.message ?? "Confirming…"}
            </>
          ) : (
            "Confirm swap"
          )}
        </button>

        {/* Show only error/success below - pending state is already in the button */}
        {(tx.status === "error" || tx.status === "success") && <TxStatus state={tx} />}
      </div>
      </div>
    </Modal>
  );
}

function SideRow({ label, symbol, amountFormatted }: { label: string; symbol: string; amountFormatted: string }) {
  return (
    <div className="rounded-2xl border border-arc-border bg-arc-bg p-4">
      <div className="mb-2 text-xs text-arc-text-muted">{label}</div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TokenIcon symbol={symbol} size={28} />
          <span className="font-medium">{symbol}</span>
        </div>
        <span className="truncate text-xl font-semibold tabular-nums" title={amountFormatted}>
          {amountFormatted}
        </span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-arc-text-muted">{label}</span>
      <span className="text-right tabular-nums text-arc-text">{value}</span>
    </div>
  );
}
