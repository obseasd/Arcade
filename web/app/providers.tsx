"use client";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { useMemo, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

// Bump this when the cache shape changes incompatibly so old localStorage
// entries get invalidated automatically on the next page load. Without
// this, a query-key migration would silently feed stale serialised cache
// rows into the new code shape.
const CACHE_BUSTER = "arcade-rq-cache-v2";

// Keep persisted entries for up to a week - covers the Lepton review
// window comfortably while still letting genuinely stale data fall out of
// the cache naturally.
const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function Providers({ children }: { children: ReactNode }) {
  // Audit 2026-06-11 UX-H-1 + V2-F-05 + Perf P0-5: refetchOnWindowFocus so
  // balances refresh on tab return, paired with a 30 s staleTime so the
  // refocus doesn't fire 30+ wagmi reads at once.
  //
  // 2026-06-14: switched QueryClientProvider -> PersistQueryClientProvider.
  // The launchpad's metadataURI scans were burning the Alchemy free-tier
  // CU budget on every cold page load even with the 50x chunk + override
  // optimisations from the last sweep. localStorage persistence collapses
  // the second-visit cost to zero: the URI per token, the metadata JSON,
  // every wagmi state read with a staleTime, all survive a hard refresh.
  // The dehydration whitelist below restricts what we persist so user-
  // specific reads (balances, allowances) never bleed across wallets.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            // Long gcTime so a recently-active query survives in memory
            // across navigations before the persister catches the next
            // dehydrate. Pages that re-mount immediately read cached
            // data instead of refetching.
            gcTime: PERSIST_MAX_AGE_MS,
          },
        },
      }),
  );

  // Sync persister against window.localStorage. We guard on the existence
  // of localStorage so the same Providers component still mounts under
  // SSR (where window is undefined) - the persister becomes a no-op.
  const persister = useMemo(() => {
    if (typeof window === "undefined") {
      // SSR path: return a stub so the prop is satisfied but no I/O
      // happens. The client will hydrate with a real one on first render.
      return createSyncStoragePersister({
        storage: {
          getItem: () => null,
          setItem: () => undefined,
          removeItem: () => undefined,
        },
      });
    }
    return createSyncStoragePersister({
      storage: window.localStorage,
      key: CACHE_BUSTER,
      throttleTime: 1_000,
    });
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: PERSIST_MAX_AGE_MS,
          buster: CACHE_BUSTER,
          dehydrateOptions: {
            // Only persist queries that are safe to survive across
            // wallets / sessions. The launchpad metadataURI + metadata
            // JSON are the big-ticket wins; anything keyed by an
            // account address stays in-memory only so a wallet switch
            // doesn't surface another wallet's balances or allowances.
            shouldDehydrateQuery: (query) => {
              if (query.state.status !== "success") return false;
              const key = query.queryKey;
              if (!Array.isArray(key) || key.length < 2) return false;
              const [ns, kind] = key as [unknown, unknown, ...unknown[]];
              if (ns !== "arcade") return false;
              return (
                kind === "tokenMetadataURI" ||
                kind === "tokenMetadata" ||
                kind === "launchpadGenerations"
              );
            },
          },
        }}
      >
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
      </PersistQueryClientProvider>
    </WagmiProvider>
  );
}
