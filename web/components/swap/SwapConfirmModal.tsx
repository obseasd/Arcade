"use client";

import { Loader2 } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import Image from "next/image";
import { Modal } from "@/components/ui/Modal";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import type { Address } from "viem";
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
  /** Estimated USD value of the input leg. */
  inputUsd?: number;
  /** Estimated USD value of the output leg. */
  outputUsd?: number;
  /** Pool-depth price impact (percent). Computed by the SwapCard from a
   *  reference quote with 1% of the user's amountIn. Drives the "high
   *  impact" warning banner inside the modal when the USD oracle is
   *  unavailable (the dominant case for ETH legs on Arc). */
  priceImpactPct?: number;
  /** 2026-06-15 audit HIGH#6: when the arcade-v3 provider has clamped
   *  the user's typed amountIn down to what the pool can absorb without
   *  crossing a tick (partial-fill), the modal shows an explicit notice
   *  so the user understands they're about to sign a smaller swap than
   *  the amount in their input field. Undefined when not in a
   *  partial-fill state. */
  partialFillNotice?: string;
  /** Display label for the route's protocol (eg "Arcade V2", "Arcade V3",
   *  "Synthra V3", "XyloNet"). Mirrors the badge under the swap card.
   *  Defaults to "Arcade V2" for the legacy code paths that don't pass it. */
  protocolLabel?: string;
  /** Optional logo path for the protocol (eg "/synthra.svg"). Renders an
   *  Image to the left of protocolLabel when provided. Used to surface
   *  the DEX brand in the confirm modal so the user knows what they're
   *  about to sign. */
  protocolLogo?: string;
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
  inputUsd,
  outputUsd,
  priceImpactPct,
  partialFillNotice,
  protocolLabel = "Arcade V2",
  protocolLogo,
}: Props) {
  const busy = tx.status === "pending";

  // Loss percentage: how much of the input's USD value the user gives up.
  // Used to escalate the modal to a red "dangerous trade" state when output
  // value is at most 50% of input. Common cause: trading into a thin pool
  // or a pool whose ratio is broken (eg first LP set the wrong price).
  const lossPct = (() => {
    if (!inputUsd || inputUsd <= 0 || outputUsd === undefined) return 0;
    return Math.max(0, (1 - outputUsd / inputUsd) * 100);
  })();
  const dangerous = lossPct >= 50;
  // Price impact panel: separate from the USD-loss "dangerous" state so
  // it fires even when the USD oracle is missing. Threshold 5% mirrors
  // the SwapCard's warn tone — the modal echoes what the user already
  // saw on the card so there's no surprise at signature time.
  const impactWarn = priceImpactPct !== undefined && priceImpactPct >= 5;
  const impactSeverityTag = priceImpactPct !== undefined && priceImpactPct >= 15
    ? "EXTREME"
    : priceImpactPct !== undefined && priceImpactPct >= 5
      ? "HIGH"
      : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      widthClassName="max-w-md"
      backdropClassName="backdrop:bg-black/30 backdrop:backdrop-blur-sm"
      className={
        dangerous
          ? "border-arc-danger/60 bg-black/45 backdrop-blur-2xl shadow-[0_0_40px_-10px_rgba(239,68,68,0.4)]"
          : "border-arc-border bg-black/45 backdrop-blur-2xl"
      }
    >
      <div className="font-sans">
      <div className={
        "flex items-center justify-between border-b px-5 py-4 " +
        (dangerous ? "border-arc-danger/40" : "border-arc-border")
      }>
        <h3 className={"text-base font-semibold " + (dangerous ? "text-arc-danger" : "")}>
          {dangerous ? "Confirm swap (high loss)" : "Confirm swap"}
        </h3>
        <button type="button"
          onClick={onClose}
          disabled={busy}
          className="text-arc-text-muted hover:text-arc-text disabled:opacity-50"
        >
          <CrossIcon size={20} />
        </button>
      </div>

      <div className="space-y-3 p-5">
        <SideRow
          label="From"
          address={tokenIn.address}
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
          address={tokenOut.address}
          symbol={tokenOut.symbol ?? "?"}
          amountFormatted={amountOutFormatted}
        />

        {dangerous && (
          <div className="rounded-xl border border-arc-danger/50 bg-arc-danger/10 p-3 text-xs">
            <div className="font-semibold text-arc-danger">
              You will lose ~{lossPct.toFixed(1)}% of value on this swap.
            </div>
            <div className="mt-1 text-arc-danger/80">
              The output is worth at most {outputUsd ? `$${outputUsd.toFixed(4)}` : "$0"} vs
              {" "}
              {inputUsd ? `$${inputUsd.toFixed(2)}` : "—"} sent in. This usually
              means the pool is too thin or its ratio is broken. Triple-check
              before signing — this loss is permanent.
            </div>
          </div>
        )}

        {partialFillNotice && (
          <div className="rounded-xl border border-arc-warn/50 bg-arc-warn/10 p-3 text-xs">
            <div className="font-semibold text-arc-warn">Partial fill</div>
            <div className="mt-1 text-arc-warn/80">{partialFillNotice}</div>
          </div>
        )}

        {!dangerous && impactWarn && priceImpactPct !== undefined && (
          <div className="rounded-xl border border-arc-danger/50 bg-arc-danger/10 p-3 text-xs">
            <div className="font-semibold text-arc-danger">
              Price impact {priceImpactPct.toFixed(2)}%{impactSeverityTag ? ` · ${impactSeverityTag}` : ""}
            </div>
            <div className="mt-1 text-arc-danger/80">
              Your trade is eating a large slice of the pool depth — the
              effective rate is materially worse than the pool's mid-price.
              Either size down or split the trade across multiple swaps so
              you stop pushing the curve.
            </div>
          </div>
        )}

        <div className="space-y-1 rounded-xl border border-arc-border bg-arc-bg p-4 text-sm">
          <Row label="Price" value={rateLabel} />
          <Row label={guardKey} value={guardLabel} />
          <div className="flex items-center justify-between py-1">
            <span className="text-arc-text-muted">Protocol</span>
            <span className="flex items-center gap-1.5 text-arc-text">
              {protocolLogo && (
                <Image
                  src={protocolLogo}
                  alt={protocolLabel}
                  width={16}
                  height={16}
                  unoptimized
                  className="h-4 w-4 object-contain"
                />
              )}
              {protocolLabel}
            </span>
          </div>
        </div>

        <button type="button"
          onClick={onConfirm}
          disabled={busy}
          className={
            dangerous
              ? "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-arc-danger py-3.5 text-base font-semibold text-white transition-colors hover:bg-arc-danger/80 disabled:opacity-50"
              : "arc-button-primary w-full py-3.5 text-base"
          }
        >
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {tx.message ?? "Confirming…"}
            </>
          ) : dangerous ? (
            "Swap anyway"
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

function SideRow({
  label,
  address,
  symbol,
  amountFormatted,
}: {
  label: string;
  address: Address;
  symbol: string;
  amountFormatted: string;
}) {
  return (
    <div className="rounded-2xl border border-arc-border bg-arc-bg p-4">
      <div className="mb-2 text-xs text-arc-text-muted">{label}</div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AutoTokenIcon address={address} symbol={symbol} size={28} />
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
