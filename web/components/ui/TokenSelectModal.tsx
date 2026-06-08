"use client";

import { Search, Check, Plus, ExternalLink } from "lucide-react";
import { CrossIcon } from "./MaskIcon";
import { useState, useMemo, useEffect, useCallback } from "react";
import { Address, erc20Abi, isAddress, zeroAddress } from "viem";
import { useReadContract } from "wagmi";
import { Modal } from "./Modal";
import { TokenIcon } from "./TokenIcon";
import { AutoTokenIcon } from "./AutoTokenIcon";
import { ADDRESSES } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { useTokenPrices } from "@/lib/hooks/useTokenPrices";
import { cn } from "@/lib/utils";

export interface TokenOption {
  address: Address;
  symbol?: string;
  name?: string;
  decimals?: number;
  pinned?: boolean;
}

interface PinnedTemplate {
  symbol: string;
  name: string;
  address?: Address;
}

interface Props {
  open: boolean;
  onClose: () => void;
  tokens: TokenOption[];
  onSelect: (token: TokenOption) => void;
  selectedAddress?: Address;
  excludeAddress?: Address;
}

const PINNED: PinnedTemplate[] = [
  { symbol: "USDC", name: "USD Coin" },
  { symbol: "ETH", name: "Wrapped Ether" },
  { symbol: "WUSDC", name: "Wrapped USDC" },
  { symbol: "USDT", name: "Tether" },
  { symbol: "BTC", name: "Wrapped BTC" },
];

export function TokenSelectModal({ open, onClose, tokens, onSelect, selectedAddress, excludeAddress }: Props) {
  const [q, setQ] = useState("");

  // Reset query on the open=false -> true transition. Render-phase
  // prev-prop check (instead of useEffect) so the cleared input shows
  // on the first paint after the modal opens, not on the paint AFTER
  // that. Pattern from
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setQ("");
  }

  // Wire the canonical ETH pin to SeedETH (the testnet mock ERC20 with 1M
  // supply pre-minted to the treasury) so the chip always lands the user
  // on something they actually hold. The Arc-native WETH at the launchpad's
  // immutable `weth` slot has 0 user balance and no liquidity, so wiring
  // the chip there gave users a dead-end. WETH stays usable via "paste
  // address" import for anyone who's bridged some in — it's just not
  // pinned. When a faucet or bridge route makes WETH user-holdable on
  // Arc, swap this back to weth.
  const pinnedTemplates: PinnedTemplate[] = useMemo(() => {
    return PINNED.map((p) => {
      if (p.symbol === "USDC") return { ...p, address: ADDRESSES.usdc };
      if (p.symbol === "ETH" && ADDRESSES.seedEth !== zeroAddress) {
        return { ...p, address: ADDRESSES.seedEth };
      }
      return p;
    });
  }, []);

  // Detect a pasted address that isn't already in the list - fetch metadata
  // and surface it as an importable token.
  const trimmedQ = q.trim();
  const pastedAddress = useMemo<Address | undefined>(() => {
    if (!isAddress(trimmedQ)) return undefined;
    const norm = trimmedQ.toLowerCase();
    if (tokens.some((t) => t.address.toLowerCase() === norm)) return undefined;
    return trimmedQ as Address;
  }, [trimmedQ, tokens]);

  // arcTestnet chain definition declares no Multicall3 address, so wagmi's
  // batched `useReadContracts` falls through to viem's
  // ChainDoesNotSupportContract path and resolves the whole call to undefined.
  // Switch to 3 independent `useReadContract` calls so each ERC20 read uses a
  // plain eth_call (which Arc supports) and partial responses are still
  // captured.
  const nameQ = useReadContract({
    address: pastedAddress,
    abi: erc20Abi,
    functionName: "name",
    query: { enabled: !!pastedAddress },
  });
  const symbolQ = useReadContract({
    address: pastedAddress,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: !!pastedAddress },
  });
  const decimalsQ = useReadContract({
    address: pastedAddress,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: !!pastedAddress },
  });
  const importedMetaQ = {
    isLoading: nameQ.isLoading || symbolQ.isLoading || decimalsQ.isLoading,
  };

  const importedToken: TokenOption | undefined = useMemo(() => {
    if (!pastedAddress) return undefined;
    const name = nameQ.data as string | undefined;
    const symbol = symbolQ.data as string | undefined;
    const decimals = decimalsQ.data as number | undefined;
    // Surface the import row as long as at least one ERC20 call succeeded.
    // Some Arc RPC nodes intermittently miss freshly-deployed contracts on
    // one of the three calls; rather than block the user we accept the hit
    // with sane defaults so the pair-creation flow can proceed.
    const allFailed =
        symbol === undefined && name === undefined && decimals === undefined;
    if (allFailed) return undefined;
    return {
        address: pastedAddress,
        name: name ?? "Imported token",
        symbol: symbol || "TOKEN",
        decimals: decimals ?? 18,
    };
  }, [pastedAddress, nameQ.data, symbolQ.data, decimalsQ.data]);

  const filtered = useMemo(() => {
    const norm = trimmedQ.toLowerCase();
    return tokens
      .filter((t) => t.address.toLowerCase() !== excludeAddress?.toLowerCase())
      .filter((t) =>
        !norm
          ? true
          : (t.symbol?.toLowerCase().includes(norm) ?? false) ||
            (t.name?.toLowerCase().includes(norm) ?? false) ||
            t.address.toLowerCase().includes(norm),
      )
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }, [tokens, trimmedQ, excludeAddress]);

  const prices = useTokenPrices(filtered);
  const explorerUrl = arcTestnet.blockExplorers?.default.url ?? "https://testnet.arcscan.app";

  const handlePinnedClick = useCallback(
    (tpl: PinnedTemplate) => {
      if (!tpl.address || tpl.address === zeroAddress) return;
      const found = tokens.find((t) => t.address.toLowerCase() === tpl.address!.toLowerCase());
      onSelect(found ?? { address: tpl.address, symbol: tpl.symbol, name: tpl.name });
      onClose();
    },
    [tokens, onSelect, onClose],
  );

  const isSelected = (addr?: Address) =>
    !!addr && !!selectedAddress && addr.toLowerCase() === selectedAddress.toLowerCase();

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
        {/* Search bar - accepts symbols, names, or any token address */}
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

        {/* Pinned chips */}
        <div className="grid grid-cols-5 gap-2">
          {pinnedTemplates.map((tpl) => {
            const enabled = !!tpl.address && tpl.address !== zeroAddress;
            const active = isSelected(tpl.address);
            return (
              <button type="button"
                key={tpl.symbol}
                onClick={() => handlePinnedClick(tpl)}
                disabled={!enabled || active}
                className={cn(
                  "relative flex flex-col items-center gap-1.5 rounded-xl border bg-black/40 p-3 transition-all",
                  enabled && !active && "hover:border-arc-cta-hover hover:bg-arc-cta/10 active:scale-95",
                  !enabled && "cursor-not-allowed opacity-50",
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

      {/* Import row when a fresh address is pasted */}
      {pastedAddress && (
        <div className="mx-3 mt-3 rounded-xl border border-arc-cta-hover/40 bg-arc-cta-hover/10 p-3">
          {importedMetaQ.isLoading ? (
            <div className="text-sm text-arc-text-muted">Looking up token at {short(pastedAddress)}…</div>
          ) : importedToken ? (
            <button type="button"
              onClick={() => {
                onSelect(importedToken);
                onClose();
              }}
              className="flex w-full items-center gap-3 text-left"
            >
              <AutoTokenIcon address={importedToken.address} symbol={importedToken.symbol} size={36} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  Import <span className="text-arc-cta-hover">{importedToken.symbol}</span>
                </div>
                <div className="truncate text-xs text-arc-text-muted">
                  {importedToken.name ?? short(pastedAddress)}
                </div>
              </div>
              <Plus className="h-4 w-4 text-arc-cta-hover" />
            </button>
          ) : (
            <div className="text-sm text-arc-text-muted">
              No ERC20 found at {short(pastedAddress)}.
            </div>
          )}
        </div>
      )}

      {/* Token list */}
      <ul className="max-h-[60vh] min-h-[200px] overflow-y-auto p-3">
        {filtered.length === 0 && !pastedAddress && (
          <li className="px-3 py-8 text-center text-sm text-arc-text-muted">No tokens found.</li>
        )}
        {filtered.map((t) => {
          const active = isSelected(t.address);
          const price = prices.get(t.address.toLowerCase());
          return (
            <li key={t.address}>
              <button type="button"
                onClick={() => {
                  if (active) return;
                  onSelect(t);
                  onClose();
                }}
                disabled={active}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors",
                  active
                    ? "cursor-default bg-arc-cta-hover/15 ring-1 ring-inset ring-arc-cta-hover/40"
                    : "hover:bg-white/5",
                )}
              >
                <AutoTokenIcon address={t.address} symbol={t.symbol} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>{t.symbol ?? "-"}</span>
                    <span className="font-mono text-[11px] font-normal text-arc-text-muted">
                      {shortAddr(t.address)}
                    </span>
                    <a
                      href={`${explorerUrl}/address/${t.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      aria-label="View on explorer"
                      className="text-arc-text-faint hover:text-arc-cta-hover"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="text-xs text-arc-text-muted">
                    {price ?? <span className="text-arc-text-faint">{t.name ?? "Token"}</span>}
                  </div>
                </div>
                {active && <Check className="h-4 w-4 text-arc-cta-hover" />}
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Format like `0x7DCfFCb...` (0x + 6 hex chars + ellipsis), matching the
 *  pattern used in the swap token rows. */
function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}...`;
}
