"use client";

import { useState } from "react";
import { BridgeCard } from "./BridgeCard";
import { BridgeHistory } from "./BridgeHistory";
import { SolanaBridgePanel } from "./SolanaBridgePanel";
import { isSolanaBridgeConfigured } from "@/lib/fx/bridgeKit";
import { cn } from "@/lib/utils";

type Mode = "evm" | "solana";

/**
 * Bridge container: lets the user pick the bridge network family.
 *
 * The EVM family (Ethereum / Base / Arbitrum / OP / Avalanche <-> Arc)
 * runs through the audited CCTP BridgeCard, untouched. The Solana family
 * (Solana <-> Arc) runs through Circle App Kit (SolanaBridgePanel). They
 * live behind a segmented toggle rather than one chain dropdown because
 * Solana is non-EVM (no chainId, different wallet) and folding it into the
 * EVM-chainId-keyed BridgeCard would mean rewiring its security-critical
 * burn/mint/resume paths. The Solana toggle only appears when a Kit Key
 * is configured.
 */
export function BridgeContainer() {
  const solanaEnabled = isSolanaBridgeConfigured();
  const [mode, setMode] = useState<Mode>("evm");
  const showSolana = solanaEnabled && mode === "solana";

  return (
    <div className="mx-auto max-w-[490px] px-4 py-8 sm:px-6 sm:py-20">
      {solanaEnabled && (
        <div className="mb-3 flex gap-1 rounded-2xl border border-arc-border bg-arc-surface p-1">
          {(["evm", "solana"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 rounded-xl py-2 text-sm font-medium transition-colors",
                mode === m
                  ? "bg-arc-cta text-arc-bg"
                  : "text-arc-gray hover:text-arc-text",
              )}
            >
              {m === "evm" ? "EVM ⇄ Arc" : "Solana ⇄ Arc"}
            </button>
          ))}
        </div>
      )}

      {showSolana ? <SolanaBridgePanel /> : <BridgeCard />}
      <BridgeHistory />
    </div>
  );
}
