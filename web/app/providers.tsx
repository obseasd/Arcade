"use client";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children }: { children: ReactNode }) {
  // Audit 2026-06-11 UX-H-1: refetchOnWindowFocus so balances, positions
  // and pool reads refresh when the user comes back to the tab. Without
  // this every wagmi useReadContract relied on its own polling interval
  // (typically 30s) and the user could see a stale MAX after a 5-min
  // tab-away, then click swap and revert. Bridge history was the only
  // surface that already listened to visibilitychange; this lifts the
  // refresh to every wagmi query at once.
  // Audit 2026-06-11 v2 V2-F-05 + Perf P0-5: pair refetchOnWindowFocus
  // with a 30s staleTime so a tab-refocus doesn't immediately re-fire 30+
  // wagmi useReadContract queries (every Arc RPC read + every aggregator
  // quote across 4 providers). Without the stale-time, alt-tabbing into
  // the SwapConfirmModal mid-sign could shift the displayed quote between
  // user-eyeball-read and wallet-sign. 30s mirrors the existing polling
  // intervals on balance hooks so the window-focus refresh aligns with
  // the cadence the rest of the app already uses.
  // staleTime + refetchOnWindowFocus combined were suspected of stalling
  // wagmi reads on a fresh page load (0 RPC calls in 5s observed on
  // /swap, /launchpad, /positions). Reverting to the wagmi default
  // QueryClient until we isolate which option is incompatible with our
  // SSR + RainbowKit + Multicall3 setup. Audit findings UX-H-1 (focus
  // refresh) + V2-F-05 (stale-time) will need a different shape later
  // — likely refetchOnWindowFocus toggled per-hook rather than globally.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#345A78",
            accentColorForeground: "#FFFFFF",
            borderRadius: "large",
            fontStack: "system",
            overlayBlur: "small",
          })}
          modalSize="compact"
          showRecentTransactions
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
