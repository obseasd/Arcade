"use client";

import { useState } from "react";
import { BridgeCard } from "@/components/bridge/BridgeCard";
import { BridgeHistory } from "@/components/bridge/BridgeHistory";
import { GatewayBridgePanel } from "@/components/bridge/GatewayBridgePanel";
import { cn } from "@/lib/utils";

type BridgeMode = "cctp" | "gateway";

/**
 * Bridge page with a mode toggle:
 *
 *   - **CCTP V2** (current, live): Circle Cross-Chain Transfer Protocol
 *     v2 burn-mint flow. Two signatures (burn on source chain, claim on
 *     Arc) with the attestation round-trip in between. Settles in
 *     ~30s end-to-end.
 *
 *   - **Gateway** (preview, not yet wired): Circle Gateway / Unified
 *     Balance. Single-signature deposit on a source chain credits a
 *     chain-agnostic USDC balance the user can spend on Arc (or
 *     anywhere else) without a separate claim step. The toggle lets
 *     us ship the surface today and wire the SDK once the integration
 *     lift is greenlit (~10-15h of work, see project memory for the
 *     migration plan).
 *
 * Both modes share the BridgeHistory panel below since the history
 * stays useful regardless of the path.
 */
export default function BridgePage() {
  const [mode, setMode] = useState<BridgeMode>("cctp");

  return (
    <div className="mx-auto max-w-[490px] px-4 py-8 sm:px-6 sm:py-20">
      <div className="mb-3 inline-flex rounded-xl border border-arc-border bg-arc-surface/40 p-1 text-xs font-semibold">
        <button
          type="button"
          data-bridge-mode="cctp"
          onClick={() => setMode("cctp")}
          className={cn(
            "rounded-lg px-3 py-1.5 transition-colors",
            mode === "cctp"
              ? "bg-arc-cta text-white shadow-sm"
              : "text-arc-text-muted hover:text-arc-text",
          )}
        >
          CCTP V2
        </button>
        <button
          type="button"
          onClick={() => setMode("gateway")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-colors",
            mode === "gateway"
              ? "bg-arc-cta text-white shadow-sm"
              : "text-arc-text-muted hover:text-arc-text",
          )}
        >
          Gateway
          <span className="rounded-full border border-arc-warn/40 bg-arc-warn/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-arc-warn">
            Preview
          </span>
        </button>
      </div>

      {mode === "cctp" ? <BridgeCard /> : <GatewayBridgePanel />}

      {/* Recent bridges from localStorage. Self-hides when empty. */}
      <BridgeHistory />
    </div>
  );
}
