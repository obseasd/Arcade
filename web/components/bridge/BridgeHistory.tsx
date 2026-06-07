"use client";

import { ExternalLink, ChevronDown, History, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  BRIDGE_HISTORY_CHANGE_EVENT,
  loadBridgeHistory,
  removeBridge,
  updateBridge,
  type HistoryEntry,
} from "@/lib/bridgeHistory";
import { fetchAttestation, getCctpChain } from "@/lib/cctp";
import { ChainIcon } from "@/components/ui/ChainIcon";
import { formatAgo, formatUSDC, cn } from "@/lib/utils";

/**
 * Recent bridges list below the main BridgeCard. Reads from localStorage so
 * each user sees only their own history. Self-collapses if there's nothing
 * yet so the main card stays the visual centerpiece for first-time users.
 *
 * Audit BRIDGE-NO-ACCOUNT-BINDING-LOCALSTORAGE: the history is scoped to
 * the currently connected wallet, so switching wallets on the same browser
 * hides the previous wallet's bridges. When no wallet is connected we
 * intentionally render nothing.
 */
export function BridgeHistory() {
  const { address: account } = useAccount();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  // Default to expanded so the user sees their most recent bridges
  // immediately. Closing the panel hides every row (closed = empty,
  // open = full list), so there's no half-state to confuse with.
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    setEntries(loadBridgeHistory(account));
    const refresh = () => setEntries(loadBridgeHistory(account));
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith("arcade_bridge_history_v1")) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(BRIDGE_HISTORY_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(BRIDGE_HISTORY_CHANGE_EVENT, refresh);
    };
  }, [account]);

  // Audit low [29]: rehydrate the "To claim" badge for orphaned pending
  // entries. The BridgeCard only flips attestationReady while the user
  // is actively on the burn flow; entries that became attestable in
  // another tab (or in a previous session) stay stuck on "Pending"
  // until the user opens the bridge card and we hit the active poll.
  // Re-poll once per 60s for any non-attestation-ready, non-minted
  // pending entry so the badge updates without the user doing anything.
  useEffect(() => {
    if (entries.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      const candidates = entries.filter(
        (e) =>
          e.status === "pending" &&
          !e.attestationReady &&
          !!e.burnTxHash &&
          getCctpChain(e.srcChainId)?.cctpDomain !== undefined,
      );
      // Fire attestation polls in parallel - each is an independent
      // Circle Iris API GET keyed on (domain, burnTxHash), with no
      // shared cursor or rate-limit semantics. Wall time drops from
      // N * latency to max(latency).
      await Promise.all(
        candidates.map(async (entry) => {
          if (cancelled) return;
          const cfg = getCctpChain(entry.srcChainId);
          if (!cfg) return;
          try {
            const att = await fetchAttestation(cfg.cctpDomain, entry.burnTxHash);
            if (att && att.status === "complete" && !cancelled && account) {
              updateBridge(account, entry.id, { attestationReady: true });
              setEntries(loadBridgeHistory(account));
            }
          } catch {
            /* network blip - try again next interval */
          }
        }),
      );
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [entries, account]);

  const dismiss = (id: string) => {
    if (!account) return;
    removeBridge(account, id);
    setEntries(loadBridgeHistory(account));
  };

  if (entries.length === 0) return null;

  // Closed -> show nothing. Open -> show every entry. The user explicitly
  // asked for this binary behaviour to avoid the half-collapsed "3 of 12"
  // state that used to confuse what "recent" means.
  const visible = expanded ? entries : [];

  return (
    <div className="mt-5 rounded-2xl border border-arc-border bg-black/15 backdrop-blur-xl">
      <button type="button"
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
      {expanded && (
        <div className="divide-y divide-arc-border/40 border-t border-arc-border/40">
          {visible.map((e) => (
            <Row key={e.id} entry={e} onDismiss={() => dismiss(e.id)} />
          ))}
        </div>
      )}
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
  const ago = formatAgo(entry.burnedAt, { suffix: "ago" });
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
      <StatusBadge status={entry.status} attestationReady={entry.attestationReady} />
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
      <button type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-arc-text-faint hover:text-arc-danger"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function StatusBadge({
  status,
  attestationReady,
}: {
  status: HistoryEntry["status"];
  attestationReady?: boolean;
}) {
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
  // Attestation in - mint not done yet. Flip the badge so the user knows
  // they have an action available rather than thinking it's still waiting
  // on Circle.
  if (attestationReady) {
    return (
      <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] font-medium text-sky-300">
        To claim
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
      Pending
    </span>
  );
}

// formatAgo lives in @/lib/utils now. Call with { suffix: "ago" } for the
// explicit "12s ago" variant used here.
