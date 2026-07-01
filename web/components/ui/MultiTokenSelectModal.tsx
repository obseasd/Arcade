"use client";

import { Search, Check, Plus } from "lucide-react";
import { CrossIcon } from "./MaskIcon";
import { useState, useMemo, useCallback } from "react";
import { Address, erc20Abi, isAddress, zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { Modal } from "./Modal";
import { TokenIcon } from "./TokenIcon";
import { ADDRESSES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { TokenOption } from "./TokenSelectModal";

interface PinnedTemplate {
  symbol: string;
  name: string;
  address?: Address;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** All addable tokens - typically all V2 tokens + USDC. */
  tokens: TokenOption[];
  /** Already-selected token addresses (current state of the multi-swap inputs). */
  initialSelected: Address[];
  /** Tokens that cannot be selected (e.g. the current output token). */
  excludeAddresses?: Address[];
  /** Maximum total selections allowed. */
  maxSelected: number;
  /** Called with the NEW addresses (not already in `initialSelected`) when confirmed. */
  onConfirm: (newlySelected: TokenOption[]) => void;
}

// Keep this list identical to TokenSelectModal's PINNED (Swap + Limit) so
// the pinned chips are the same everywhere the user picks a token. It used
// to pin WUSDC + BTC here, which diverged from the Swap/Limit chips
// (EURC + cirBTC) and confused users switching between the surfaces.
const PINNED: PinnedTemplate[] = [
  { symbol: "USDC", name: "USD Coin" },
  { symbol: "ETH", name: "Wrapped Ether" },
  { symbol: "EURC", name: "Euro Coin" },
  { symbol: "USDT", name: "Tether" },
  { symbol: "cirBTC", name: "Circle Wrapped BTC" },
];

export function MultiTokenSelectModal({
  open,
  onClose,
  tokens,
  initialSelected,
  excludeAddresses,
  maxSelected,
  onConfirm,
}: Props) {
  const [q, setQ] = useState("");
  // Working selection (lowercased addresses) - staged client-side until Confirm.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset on the open=false -> true transition. Stored as a prev-prop check
  // during render rather than a useEffect: the effect-based version showed a
  // brief stale UI between the prop change and the re-render committed by the
  // setQ/setSelected calls (`https://react.doctr/r/state-synced-to-prop-in-effect`).
  // Doing it in render schedules the state update synchronously so the next
  // paint already sees the cleared input + seeded selection set.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQ("");
      setSelected(new Set(initialSelected.map((a) => a.toLowerCase())));
    }
  }

  const pinnedTemplates: PinnedTemplate[] = useMemo(
    () =>
      PINNED.map((p) => ({
        ...p,
        address:
          p.symbol === "USDC"
            ? ADDRESSES.usdc
            : p.symbol === "ETH"
              ? ADDRESSES.seedEth
              : p.symbol === "EURC"
                ? ADDRESSES.eurc
                : p.symbol === "USDT"
                  ? ADDRESSES.usdt
                  : p.symbol === "cirBTC"
                    ? ADDRESSES.cirBtc
                    : undefined,
      })),
    [],
  );

  const trimmedQ = q.trim();
  const pastedAddress = useMemo<Address | undefined>(() => {
    if (!isAddress(trimmedQ)) return undefined;
    const norm = trimmedQ.toLowerCase();
    if (tokens.some((t) => t.address.toLowerCase() === norm)) return undefined;
    return trimmedQ as Address;
  }, [trimmedQ, tokens]);

  const importedMetaQ = useReadContracts({
    contracts: pastedAddress
      ? [
          { address: pastedAddress, abi: erc20Abi, functionName: "name" },
          { address: pastedAddress, abi: erc20Abi, functionName: "symbol" },
          { address: pastedAddress, abi: erc20Abi, functionName: "decimals" },
        ]
      : [],
    query: { enabled: !!pastedAddress },
  });

  const importedToken: TokenOption | undefined = useMemo(() => {
    if (!pastedAddress || !importedMetaQ.data) return undefined;
    const name = importedMetaQ.data[0]?.result as string | undefined;
    const symbol = importedMetaQ.data[1]?.result as string | undefined;
    const decimals = importedMetaQ.data[2]?.result as number | undefined;
    if (!symbol || decimals === undefined) return undefined;
    return { address: pastedAddress, name, symbol, decimals };
  }, [pastedAddress, importedMetaQ.data]);

  const excludeSet = useMemo(
    () => new Set((excludeAddresses ?? []).map((a) => a.toLowerCase())),
    [excludeAddresses],
  );

  const filtered = useMemo(() => {
    const norm = trimmedQ.toLowerCase();
    return tokens
      .filter((t) => !excludeSet.has(t.address.toLowerCase()))
      .filter((t) =>
        !norm
          ? true
          : (t.symbol?.toLowerCase().includes(norm) ?? false) ||
            (t.name?.toLowerCase().includes(norm) ?? false) ||
            t.address.toLowerCase().includes(norm),
      )
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }, [tokens, trimmedQ, excludeSet]);

  const toggle = useCallback(
    (addr: Address) => {
      const norm = addr.toLowerCase();
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(norm)) {
          next.delete(norm);
        } else {
          if (next.size >= maxSelected) return prev; // cap
          next.add(norm);
        }
        return next;
      });
    },
    [maxSelected],
  );

  const isSelected = (addr?: Address) => !!addr && selected.has(addr.toLowerCase());

  const handlePinnedClick = useCallback(
    (tpl: PinnedTemplate) => {
      if (!tpl.address || tpl.address === zeroAddress) return;
      if (excludeSet.has(tpl.address.toLowerCase())) return;
      toggle(tpl.address);
    },
    [toggle, excludeSet],
  );

  // Build a quick lookup so Confirm can return TokenOption (not raw addresses)
  const tokenByAddr = useMemo(() => {
    const m = new Map<string, TokenOption>();
    for (const t of tokens) m.set(t.address.toLowerCase(), t);
    if (importedToken) m.set(importedToken.address.toLowerCase(), importedToken);
    // Pinned tokens that resolve to an address but aren't in `tokens` yet
    for (const tpl of pinnedTemplates) {
      if (!tpl.address || tpl.address === zeroAddress) continue;
      const k = tpl.address.toLowerCase();
      if (!m.has(k)) m.set(k, { address: tpl.address, symbol: tpl.symbol, name: tpl.name });
    }
    return m;
  }, [tokens, importedToken, pinnedTemplates]);

  const onConfirmClick = useCallback(() => {
    const initialSet = new Set(initialSelected.map((a) => a.toLowerCase()));
    const newOnes: TokenOption[] = [];
    for (const norm of selected) {
      if (initialSet.has(norm)) continue;
      const t = tokenByAddr.get(norm);
      if (t) newOnes.push(t);
    }
    onConfirm(newOnes);
    onClose();
  }, [selected, initialSelected, tokenByAddr, onConfirm, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClassName="max-w-md"
      backdropClassName="bg-black/30 backdrop-blur-sm"
      className="border-arc-border bg-black/45 backdrop-blur-2xl"
    >
      <div className="flex items-center justify-between border-b border-arc-border px-6 py-4">
        <h3 className="text-base font-semibold">Select a token</h3>
        <button type="button" onClick={onClose} className="text-arc-text-muted hover:text-arc-text">
          <CrossIcon size={20} />
        </button>
      </div>

      <div className="space-y-4 px-6 pt-5">
        <div className="flex items-center gap-2 rounded-xl border border-arc-border bg-black/40 px-3 py-2.5">
          <Search className="h-4 w-4 text-arc-text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or paste address"
            className="arc-input text-sm"
            aria-label="Search tokens"
          />
        </div>

        <div className="grid grid-cols-5 gap-2">
          {pinnedTemplates.map((tpl) => {
            const enabled = !!tpl.address && tpl.address !== zeroAddress;
            const excluded = !!tpl.address && excludeSet.has(tpl.address.toLowerCase());
            const active = isSelected(tpl.address);
            return (
              <button type="button"
                key={tpl.symbol}
                onClick={() => handlePinnedClick(tpl)}
                disabled={!enabled || excluded}
                className={cn(
                  "relative flex flex-col items-center gap-1.5 rounded-xl border bg-black/40 p-3 transition-all",
                  enabled && !excluded && "hover:border-arc-cta-hover hover:bg-arc-cta/10 active:scale-95",
                  (!enabled || excluded) && "cursor-not-allowed opacity-50",
                  active
                    ? "border-arc-cta-hover bg-arc-cta-hover/25 shadow-arc-nav-glow"
                    : "border-arc-border",
                )}
              >
                <TokenIcon symbol={tpl.symbol} size={32} />
                <span className="text-xs font-medium">{tpl.symbol}</span>
                {!enabled && (
                  <span className="absolute -right-1 -top-1 rounded-full bg-arc-surface-3 px-1.5 py-0.5 text-[8px] font-medium uppercase text-arc-text-muted">
                    Soon
                  </span>
                )}
                {active && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-arc-cta-hover text-white">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {pastedAddress && (
        <div className="mx-3 mt-3 rounded-xl border border-arc-cta-hover/40 bg-arc-cta-hover/10 p-3">
          {importedMetaQ.isLoading ? (
            <div className="text-sm text-arc-text-muted">Looking up token at {short(pastedAddress)}…</div>
          ) : importedToken ? (
            <button type="button"
              onClick={() => toggle(importedToken.address)}
              className="flex w-full items-center gap-3 text-left"
            >
              <TokenIcon symbol={importedToken.symbol} size={36} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {isSelected(importedToken.address) ? "Unselect" : "Add"}{" "}
                  <span className="text-arc-cta-hover">{importedToken.symbol}</span>
                </div>
                <div className="truncate text-xs text-arc-text-muted">
                  {importedToken.name ?? short(pastedAddress)}
                </div>
              </div>
              {isSelected(importedToken.address) ? (
                <Check className="h-4 w-4 text-arc-cta-hover" />
              ) : (
                <Plus className="h-4 w-4 text-arc-cta-hover" />
              )}
            </button>
          ) : (
            <div className="text-sm text-arc-text-muted">No ERC20 found at {short(pastedAddress)}.</div>
          )}
        </div>
      )}

      <ul className="max-h-[50vh] min-h-[200px] overflow-y-auto p-3">
        {filtered.length === 0 && !pastedAddress && (
          <li className="px-3 py-8 text-center text-sm text-arc-text-muted">No tokens found.</li>
        )}
        {filtered.map((t) => {
          const active = isSelected(t.address);
          const atCap = !active && selected.size >= maxSelected;
          return (
            <li key={t.address}>
              <button type="button"
                onClick={() => toggle(t.address)}
                disabled={atCap}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors",
                  active && "bg-arc-cta-hover/15 ring-1 ring-inset ring-arc-cta-hover/40",
                  !active && !atCap && "hover:bg-white/5",
                  atCap && "cursor-not-allowed opacity-40",
                )}
              >
                <TokenIcon symbol={t.symbol} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{t.symbol ?? "-"}</div>
                  <div className="truncate text-xs text-arc-text-muted">{t.name ?? t.address}</div>
                </div>
                {active && <Check className="h-4 w-4 text-arc-cta-hover" />}
              </button>
            </li>
          );
        })}
      </ul>

      {/* Footer: counter + confirm */}
      <div className="flex items-center justify-between gap-3 border-t border-arc-border px-5 py-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-arc-text-muted">Selected</span>
          <span className="font-semibold tabular-nums">
            <span
              className={cn(selected.size > 0 ? "text-arc-cta-hover" : "text-arc-text")}
            >
              {selected.size}
            </span>
            <span className="text-arc-text-muted">/{maxSelected}</span>
          </span>
        </div>
        <div className="flex -space-x-1.5">
          {Array.from(selected)
            .slice(0, 4)
            .map((norm) => {
              const tk = tokenByAddr.get(norm);
              return (
                <span
                  key={norm}
                  className="inline-flex items-center justify-center rounded-full ring-2 ring-arc-bg"
                >
                  <TokenIcon symbol={tk?.symbol} size={24} />
                </span>
              );
            })}
          {selected.size > 4 && (
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-arc-surface-2 text-[10px] font-semibold ring-2 ring-arc-bg">
              +{selected.size - 4}
            </span>
          )}
        </div>
      </div>
      <div className="px-5 pb-5">
        <button type="button"
          onClick={onConfirmClick}
          disabled={selected.size === 0}
          className="arc-button-primary w-full py-3 text-sm"
        >
          Confirm
        </button>
      </div>
    </Modal>
  );
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
