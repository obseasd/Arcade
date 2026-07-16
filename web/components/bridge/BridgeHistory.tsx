"use client";

import { ExternalLink, ChevronDown, History } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
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
import { TokenIcon } from "@/components/ui/TokenIcon";
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

  // Audit Bridge H-3: re-promote a failed entry to "pending" + signal
  // BridgeCard to enter the attestation poll for it. Without this the
  // user's only "recovery" path after a failed bridge was to manually
  // dig the attestation out of Iris with curl. The CustomEvent payload
  // lets BridgeCard pick up the entry without coupling the two
  // components via prop drilling.
  const onRetry = (entry: HistoryEntry) => {
    if (!account) return;
    updateBridge(account, entry.id, {
      status: "pending",
      attestationReady: false,
    });
    setEntries(loadBridgeHistory(account));
    window.dispatchEvent(
      new CustomEvent("arcade-bridge-retry", {
        detail: {
          burnTxHash: entry.burnTxHash,
          srcChainId: entry.srcChainId,
          dstChainId: entry.dstChainId,
          amountRaw6: entry.amountRaw6,
          recipient: entry.recipient,
        },
      }),
    );
  };
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
      // BRIDGE-HISTORY-IRIS-FANOUT: skip when the tab is in the background.
      // Without this gate the setInterval keeps firing every 60s on a
      // hidden tab, fanning out up to MAX_ENTRIES=20 parallel Iris GETs
      // from a user who has the tab pinned but isn't looking at it. Pause
      // until visibility returns; visibilitychange below kicks off a fresh
      // poll immediately when the tab comes back.
      if (typeof document !== "undefined" && document.hidden) return;
      // Audit Bridge H-5: stop polling entries older than 24h that have
      // never seen attestationReady=true. Without this cap, a burn that
      // Iris never returned for (network outage on either side, source-
      // chain reorg before finality, etc.) keeps the poll firing forever
      // and burns IP rate-limit budget on every user. After 24h the row
      // is auto-flipped to "failed" so the user can dismiss it from the
      // history surface.
      const STALE_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      if (account) {
        for (const e of entries) {
          if (
            e.status === "pending" &&
            !e.attestationReady &&
            now - e.burnedAt > STALE_MS
          ) {
            updateBridge(account, e.id, { status: "failed" });
          }
        }
      }
      const candidates = entries.filter(
        (e) =>
          e.status === "pending" &&
          !e.attestationReady &&
          !!e.burnTxHash &&
          now - e.burnedAt <= STALE_MS &&
          getCctpChain(e.srcChainId)?.cctpDomain !== undefined,
      );
      // Cap the fanout. Even with the Visibility gate, a user with the
      // tab focused but many historical pendings would still issue 20
      // parallel requests every 60s; the cap of 5 keeps the load
      // predictable while still draining the queue across rounds.
      const slice = candidates.slice(0, 5);
      await Promise.all(
        slice.map(async (entry) => {
          if (cancelled) return;
          const cfg = getCctpChain(entry.srcChainId);
          if (!cfg) return;
          try {
            const att = await fetchAttestation(cfg.cctpDomain, entry.burnTxHash);
            if (att && att.status === "complete" && !cancelled && account) {
              // Audit 2026-06-11 bug #8: cache the message + signature
              // blobs alongside the flag. BridgeCard's storage listener
              // re-validates them and transitions to "minting" as soon
              // as the badge flips, removing the 60-vs-6 s race that
              // left the claim button greyed out for 2+ minutes.
              updateBridge(account, entry.id, {
                attestationReady: true,
                attestationMessage: att.message as `0x${string}`,
                attestationSignature: att.attestation as `0x${string}`,
              });
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
    const onVisible = () => {
      if (!document.hidden && !cancelled) poll();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      cancelled = true;
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
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
            <Row
              key={e.id}
              entry={e}
              onDismiss={() => dismiss(e.id)}
              onRetry={onRetry}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  entry,
  onDismiss,
  onRetry,
}: {
  entry: HistoryEntry;
  onDismiss: () => void;
  onRetry: (entry: HistoryEntry) => void;
}) {
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
  // Suppress the explorer link for entries with no real source tx hash
  // (e.g. the App Kit Solana bridge, recorded with a zero-hash placeholder)
  // so it doesn't point at a 404.
  const ZERO_HASH = `0x${"0".repeat(64)}`;
  const hasRealTx = !!entry.burnTxHash && entry.burnTxHash !== ZERO_HASH;
  const explorerTx =
    src?.explorer && hasRealTx
      ? `${src.explorer}/tx/${entry.burnTxHash}`
      : undefined;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-xs">
      <div className="flex items-center gap-1">
        <ChainIcon chainId={entry.srcChainId} size={16} />
        <span className="text-arc-text-faint">→</span>
        <ChainIcon chainId={entry.dstChainId} size={16} />
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 truncate font-medium tabular-nums">
          {/* USDC glyph in front of the amount, matching how the Activity
              tab AmountCell renders its leading token logo. */}
          <TokenIcon symbol="USDC" size={16} />
          {amount} <span className="text-arc-text-muted">USDC</span>
        </div>
        {/* Drop the "Avalanche Fuji → Arc Testnet" subtitle - the source
            and destination are already conveyed by the two ChainIcons
            on the left, so repeating the chain names was noise. Just
            push the relative timestamp inline next to the amount. */}
        <span className="shrink-0 text-[10px] text-arc-text-faint">{ago}</span>
      </div>
      <KeeperRelayBadge burnTxHash={entry.burnTxHash} clientStatus={entry.status} />
      <StatusBadge status={entry.status} attestationReady={entry.attestationReady} />
      {/* Audit Bridge H-3: Retry button on failed rows so the user has
          a way back into the attestation poll without manually
          fetching an attestation off-chain. Re-promotes the entry to
          "pending" status and rehydrates the BridgeCard form via the
          onRetry callback, which sets srcChainId / dstChainId / amount
          and parks step in "attesting". */}
      {entry.status === "failed" && (
        <button
          type="button"
          onClick={() => onRetry(entry)}
          className="rounded-md border border-arc-border bg-arc-bg-elevated px-2 py-0.5 text-[10px] font-medium text-arc-text hover:bg-white/5"
        >
          Retry
        </button>
      )}
      {/* Reserve the link slot even when there's no tx, so the trailing
          timestamp / dismiss column stays aligned across rows. */}
      {explorerTx ? (
        <a
          href={explorerTx}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View burn tx"
          className="text-arc-text-faint hover:text-arc-cta-hover"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <span className="inline-block h-3 w-3" aria-hidden />
      )}
      {/* Dismiss: hide a stuck entry locally. Useful when the burn was made
          before the burnTxHash auto-patch shipped and the entry is stranded
          as "pending" even though the user has already minted. */}
      <button type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-arc-text-faint hover:text-arc-danger"
      >
        <CrossIcon size={12} />
      </button>
    </div>
  );
}

/**
 * Surfaces the unified keeper's leg-B relay status for a hooked bridge
 * (buy/forward), so the user can see the keeper is auto-completing the buy on
 * Arc and they don't need to come back to claim. Only rendered while the
 * client's own view is still non-terminal (pending / attesting): once the mint
 * lands the row flips to "Claimed" on its own, at which point the keeper badge
 * would be redundant. Polls /api/bridge/intent every 20s while waiting.
 *
 * Shows nothing when no intent exists for the hash (a plain no-hook bridge, or
 * the DB is unconfigured), so a badge only ever appears when the keeper is
 * genuinely engaged. Best-effort: any fetch error just leaves it blank.
 */
function KeeperRelayBadge({
  burnTxHash,
  clientStatus,
}: {
  burnTxHash?: string;
  clientStatus: HistoryEntry["status"];
}) {
  const [relay, setRelay] = useState<
    | { status: "pending" | "relaying" | "relayed" | "failed" | "expired"; relayTxHash: string | null }
    | null
  >(null);
  const terminal = clientStatus === "minted" || clientStatus === "failed";
  const ZERO_HASH = `0x${"0".repeat(64)}`;

  useEffect(() => {
    // No point querying once the client already resolved, or for a
    // placeholder hash (Solana App Kit rows).
    if (terminal || !burnTxHash || burnTxHash === ZERO_HASH) {
      setRelay(null);
      return;
    }
    let alive = true;
    let iv: ReturnType<typeof setInterval> | null = null;
    let polls = 0;
    // Safety cutoff (~15 min at 20s). A hooked intent is recorded within
    // seconds of the burn, so a still-null intent past this is a plain
    // no-hook bridge that will never have one -> stop polling. A genuine
    // keeper relay reaches 'relayed' (and stops below) well inside this.
    const MAX_POLLS = 45;
    const stop = () => {
      if (iv !== null) {
        clearInterval(iv);
        iv = null;
      }
    };
    const load = async () => {
      // Don't poll a backgrounded tab (mirrors the Iris poller's gate two
      // functions up); the next visible tick catches up (and doesn't count
      // toward MAX_POLLS).
      if (typeof document !== "undefined" && document.hidden) return;
      polls += 1;
      try {
        const r = await fetch(
          `/api/bridge/intent?burnTxHash=${burnTxHash}`,
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const j = (await r.json()) as { intent?: { status: string; relayTxHash: string | null } | null };
        if (!alive) return;
        const it = j?.intent;
        // Only badge the in-flight/settled keeper states.
        if (it && (it.status === "pending" || it.status === "relaying" || it.status === "relayed")) {
          setRelay({ status: it.status as "pending" | "relaying" | "relayed", relayTxHash: it.relayTxHash });
          // 'relayed' is terminal (buy done on Arc) -> stop; the client row
          // flips to "Claimed" on its own.
          if (it.status === "relayed") stop();
        } else {
          setRelay(null);
          // A terminal keeper FAILURE (failed/expired) will not change ->
          // stop polling (manual claim is the fallback). A null intent may
          // still appear shortly for a hooked bridge, so keep polling until
          // the MAX_POLLS cutoff handles the plain-bridge (always-null) case.
          if (it) stop();
        }
      } catch {
        /* best-effort: no badge */
      } finally {
        if (polls >= MAX_POLLS) stop();
      }
    };
    void load();
    iv = setInterval(load, 20_000);
    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burnTxHash, terminal]);

  if (!relay) return null;
  const label =
    relay.status === "relayed"
      ? "Auto-claimed"
      : relay.status === "relaying"
        ? "Keeper relaying"
        : "Keeper queued";
  const tone =
    relay.status === "relayed"
      ? "bg-arc-success/15 text-arc-success"
      : "bg-sky-400/15 text-sky-300";
  return (
    <span
      className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", tone)}
      title="The unified keeper auto-relays your bridged buy on Arc so you don't have to claim manually."
    >
      {label}
    </span>
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
