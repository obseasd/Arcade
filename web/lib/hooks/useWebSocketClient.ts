"use client";

import { useEffect, useRef } from "react";
import { PublicClient, createPublicClient, webSocket, http } from "viem";
import { arcTestnet } from "@/lib/chains";

/**
 * Single shared WebSocket public client for Arc testnet. Used for live event
 * subscriptions (Buy/Sell on launchpad, Swap on V3 pools, etc) so the UI
 * updates instantly instead of polling.
 *
 * The connection is opened lazily on first call and reused across components.
 * Reconnect logic is handled by viem's webSocket transport.
 */
let cachedClient: PublicClient | undefined;

function getWsClient(): PublicClient {
  if (!cachedClient) {
    const wsUrl = arcTestnet.rpcUrls.default.webSocket?.[0];
    cachedClient = createPublicClient({
      chain: arcTestnet,
      // Arc mainnet has no known public WS endpoint yet, so when none is set we
      // degrade to an http client (polling) instead of a broken empty WS URL.
      transport: wsUrl
        ? webSocket(wsUrl, {
            retryCount: 5,
            retryDelay: 2_000,
            keepAlive: { interval: 30_000 },
            reconnect: true,
          })
        : http(),
    });
  }
  return cachedClient;
}

/** Returns the shared WS public client, or undefined during SSR. */
export function useWebSocketPublicClient(): PublicClient | undefined {
  const ref = useRef<PublicClient | undefined>(undefined);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!ref.current) ref.current = getWsClient();
  }, []);
  return typeof window === "undefined" ? undefined : getWsClient();
}
