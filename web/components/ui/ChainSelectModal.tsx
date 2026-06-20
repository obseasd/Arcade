"use client";

import { Check } from "lucide-react";
import { CrossIcon } from "./MaskIcon";
import { Modal } from "./Modal";
import { ChainIcon } from "./ChainIcon";
import { CCTP_CHAINS } from "@/lib/cctp";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (chainId: number) => void;
  selectedChainId?: number;
  excludeChainId?: number;
  title?: string;
  /** Non-CCTP chains appended to the list (e.g. Solana). Rendered with a
   *  letter-badge fallback since they have no ChainIcon. */
  extraChains?: { id: number; name: string }[];
}

export function ChainSelectModal({
  open,
  onClose,
  onSelect,
  selectedChainId,
  excludeChainId,
  title = "Select a chain",
  extraChains = [],
}: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClassName="max-w-md"
      backdropClassName="bg-black/30 backdrop-blur-sm"
      className="border-arc-border bg-black/45 backdrop-blur-2xl"
    >
      <div className="flex items-center justify-between border-b border-arc-border px-6 py-4">
        <h3 className="text-base font-semibold">{title}</h3>
        <button type="button" onClick={onClose} className="text-arc-text-muted hover:text-arc-text">
          <CrossIcon size={20} />
        </button>
      </div>

      <ul className="max-h-[60vh] overflow-y-auto p-3">
        {CCTP_CHAINS.map((chain) => {
          const isSelected = chain.id === selectedChainId;
          const isExcluded = chain.id === excludeChainId;
          return (
            <li key={chain.id}>
              <button type="button"
                onClick={() => {
                  if (isExcluded) return;
                  onSelect(chain.id);
                  onClose();
                }}
                disabled={isExcluded}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors",
                  isSelected
                    ? "cursor-default bg-arc-cta-hover/15 ring-1 ring-inset ring-arc-cta-hover/40"
                    : isExcluded
                      ? "cursor-not-allowed opacity-40"
                      : "hover:bg-white/5",
                )}
              >
                <ChainIcon chainId={chain.id} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{chain.name}</div>
                </div>
                {isSelected && <Check className="h-4 w-4 text-arc-cta-hover" />}
                {isExcluded && (
                  <span className="rounded-full bg-arc-surface-3 px-2 py-0.5 text-[10px] uppercase text-arc-text-muted">
                    In use
                  </span>
                )}
              </button>
            </li>
          );
        })}

        {extraChains.map((chain) => {
          const isSelected = chain.id === selectedChainId;
          const isExcluded = chain.id === excludeChainId;
          return (
            <li key={chain.id}>
              <button
                type="button"
                onClick={() => {
                  if (isExcluded) return;
                  onSelect(chain.id);
                  onClose();
                }}
                disabled={isExcluded}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors",
                  isSelected
                    ? "cursor-default bg-arc-cta-hover/15 ring-1 ring-inset ring-arc-cta-hover/40"
                    : isExcluded
                      ? "cursor-not-allowed opacity-40"
                      : "hover:bg-white/5",
                )}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] text-sm font-bold text-black">
                  {chain.name.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{chain.name}</div>
                </div>
                {isSelected && <Check className="h-4 w-4 text-arc-cta-hover" />}
                {isExcluded && (
                  <span className="rounded-full bg-arc-surface-3 px-2 py-0.5 text-[10px] uppercase text-arc-text-muted">
                    In use
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
