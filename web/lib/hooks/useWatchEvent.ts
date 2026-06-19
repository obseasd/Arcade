"use client";

import { useEffect, useRef } from "react";
import { Address, AbiEvent, Log } from "viem";
import { useWebSocketPublicClient } from "./useWebSocketClient";

interface Options {
  address: Address | Address[] | undefined;
  event: AbiEvent;
  args?: Record<string, unknown>;
  enabled?: boolean;
  /** Called with the array of matched logs each time the WS pushes a batch. */
  onLogs: (logs: Log[]) => void;
}

/**
 * Subscribes to an on-chain event via WebSocket and calls `onLogs` whenever
 * the chain pushes new matching logs. Cleans up automatically on unmount or
 * when `address` / `enabled` change.
 *
 * Wrap with `useCallback` for `onLogs` to avoid resubscribing on every render.
 */
export function useWatchEvent({ address, event, args, enabled = true, onLogs }: Options) {
  const client = useWebSocketPublicClient();
  // Stash the callback in a ref so resubscribing isn't tied to identity changes.
  const cb = useRef(onLogs);
  useEffect(() => {
    cb.current = onLogs;
  }, [onLogs]);

  // Audit 2026-06-18b M-23: depending on the `args` object identity
  // tore down + re-created the WS subscription on every render whenever
  // a caller passed an inline `args={{ token }}` literal. Derive a
  // stable string key from the args' contents (bigint-safe) and depend
  // on THAT, so we only resubscribe when the actual filter values
  // change, not when the parent re-renders. `args` itself is still read
  // inside the effect (captured); argsKey only gates re-runs.
  const argsKey = args
    ? JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
    : "";
  useEffect(() => {
    if (!client || !address || !enabled) return;
    const unwatch = client.watchEvent({
      address,
      event,
      args,
      onLogs: (logs) => cb.current(logs),
    });
    return () => {
      unwatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, address, event, argsKey, enabled]);
}
