"use client";

import { ExternalLink, ChevronDown, History, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  BRIDGE_HISTORY_CHANGE_EVENT,
  loadBridgeHistory,
  removeBridge,
  type HistoryEntry,
} from "@/lib/bridgeHistory";
import { getCctpChain } from "@/lib/cctp";
import { ChainIcon } from "@/components/ui/ChainIcon";
import { formatUSDC, cn } from "@/lib/utils";

/**
 * Recent bridges list below the main BridgeCard. Reads from localStorage so
 * each user sees only their own history. Self-collapses if there's nothing
 * yet so the main card stays the visual centerpiece for first-time users.
 */
export function BridgeHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  // Default to expanded so the user sees their most recent bridges
  // immediately. Closing the panel hides every row (closed = empty,
  // open = full list), so there's no half-state to confuse with.
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    setEntries(loadBridgeHistory());
    // Subscribe to storage events from OTHER tabs.
    const onStorage = (e: StorageEvent) => {
      if (e.key === "arcade_bridge_history_v1") setEntries(loadBridgeHistory());
    };
    // Subscribe to our custom event for SAME-tab updates. The native
    // "storage" event never fires on the tab that wrote, so the user's
    // own bridge would stay invisible until refresh without this.
    const onChange = () => setEntries(loadBridgeHistory());
    window.addEventListener("storage", onStorage);
    window.addEventListener(BRIDGE_HISTORY_CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(BRIDGE_HISTORY_CHANGE_EVENT, onChange);
    };
  }, []);

  const dismiss = (id: string) => {
    removeBridge(id);
    setEntries(loadBridgeHistory());
  };

  if (entries.length === 0) return null;

  // Closed -> show nothing. Open -> show every entry. The user explicitly
  // asked for this binary behaviour to avoid the half-collapsed "3 of 12"
  // state that used to confuse what "recent" means.
  const visible = expanded ? entries : [];

  return (
    <div className="mt-5 rounded-2xl border border-arc-border bg-black/15 backdrop-blur-xl">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-arc-text-muted" />
          <span className="text-sm font-medium">Recent bridges</span>
          <span className="text-xs text-arc-text-faint">({entries.length})</span>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-arc-text-muted transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      <div className="divide-y divide-arc-border/40 border-t border-arc-border/40">
        {visible.map((e) => (
          <Row key={e.id} entry={e} onDismiss={() => dismiss(e.id)} />
        ))}
      </div>
    </div>
  );
}

function Row({ entry, onDismiss }: { entry: HistoryEntry; onDismiss: () => void }) {
  const src = getCctpChain(entry.srcChainId);
  const dst = getCctpChain(entry.dstChainId);
  const amount = (() => {
    try {
      return formatUSDC(BigInt(entry.amountRaw6), 6, 2);
    } catch {
      return "?";
    }
  })();
  const ago = formatAgo(entry.burnedAt);
  const explorerTx = src?.explorer ? `${src.explorer}/tx/${entry.burnTxHash}` : undefined;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-xs">
      <div className="flex items-center gap-1">
        <ChainIcon chainId={entry.srcChainId} size={16} />
        <span className="text-arc-text-faint">→</span>
        <ChainIcon chainId={entry.dstChainId} size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium tabular-nums">
          {amount} <span className="text-arc-text-muted">USDC</span>
        </div>
        <div className="truncate text-[10px] text-arc-text-faint">
          {src?.name ?? "?"} → {dst?.name ?? "?"} · {ago}
        </div>
      </div>
      <StatusBadge status={entry.status} />
      {explorerTx && (
        <a
          href={explorerTx}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View burn tx"
          className="text-arc-text-faint hover:text-arc-cta-hover"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {/* Dismiss: hide a stuck entry locally. Useful when the burn was made
          before the burnTxHash auto-patch shipped and the entry is stranded
          as "pending" even though the user has already minted. */}
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-arc-text-faint hover:text-arc-danger"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: HistoryEntry["status"] }) {
  if (status === "minted") {
    return (
      <span className="rounded-full bg-arc-success/15 px-2 py-0.5 text-[10px] font-medium text-arc-success">
        Claimed
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="rounded-full bg-arc-danger/15 px-2 py-0.5 text-[10px] font-medium text-arc-danger">
        Failed
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
      Pending
    </span>
  );
}

function formatAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
