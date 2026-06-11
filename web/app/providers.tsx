"use client";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children }: { children: ReactNode }) {
  // Audit 2026-06-11 UX-H-1 + V2-F-05 + Perf P0-5 (RE-APPLIED 2026-06-11
  // after multicall3 trap fix in c247083): refetchOnWindowFocus so
  // balances + pool reads refresh when the user re-focuses the tab, paired
  // with a 30 s staleTime so a tab-refocus doesn't immediately re-fire 30+
  // wagmi useReadContract queries (every Arc RPC read + every aggregator
  // quote across 4 providers).
  //
  // Without refetchOnWindowFocus, every wagmi useReadContract relied on
  // its own polling interval (typically 30 s) and the user could see a
  // stale MAX after a 5-min tab-away, then click swap and revert. Bridge
  // history was the only surface that already listened to visibilitychange;
  // this lifts the refresh to every wagmi query at once.
  //
  // Without staleTime, alt-tabbing into the SwapConfirmModal mid-sign
  // could shift the displayed quote between user-eyeball-read and wallet-
  // sign. 30 s mirrors the existing polling intervals on balance hooks so
  // the window-focus refresh aligns with the cadence the rest of the app
  // already uses.
  //
  // History: briefly reverted while we hunted the frozen-reads bug, which
  // turned out to be a wrong-multicall3-address trap (see chains.ts) not
  // a TanStack config issue. Safe to re-enable now.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
      },
    },
  }));

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
