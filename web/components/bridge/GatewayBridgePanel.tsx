"use client";

import Link from "next/link";
import { Info, Sparkles } from "lucide-react";

/**
 * Gateway preview surface. Mounts when the user toggles to "Gateway"
 * mode on /bridge. Renders a description of the upcoming flow plus a
 * clear "not yet wired" banner so we can ship the toggle without
 * pretending the SDK is integrated.
 *
 * Wiring TODO (tracked in reference_arc_v0_7_2_primitives memory):
 *   1. Pull in @circle-fin/gateway-sdk (or equivalent).
 *   2. Replace the placeholder body with `kit.deposit({ from, amount })`
 *      flow + chain-agnostic balance reads + `kit.spend()` exits.
 *   3. Mirror the BridgeHistory's localStorage pattern for state.
 *
 * Surfaces below the toggle so the BridgeHistory list keeps its place.
 */
export function GatewayBridgePanel() {
  return (
    <div className="arc-card space-y-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-400/10 text-sky-400">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h2 className="text-base font-semibold text-arc-text">
            Gateway · Unified Balance
          </h2>
          <p className="mt-1 text-xs text-arc-text-muted">
            Deposit USDC from any supported chain once. Use the credited
            balance instantly on Arc (no attestation wait, no separate
            claim step), spend back to any destination when you cash out.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-arc-warn/30 bg-arc-warn/5 p-3 text-[11px] text-arc-warn">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
          <Info className="h-3.5 w-3.5" />
          Preview
        </div>
        Toggle is live, SDK plumbing lands in the next sprint. For
        anything you need to bridge in today, flip back to{" "}
        <button
          type="button"
          onClick={() => {
            const el = document.querySelector(
              "button[data-bridge-mode='cctp']",
            ) as HTMLButtonElement | null;
            el?.click();
          }}
          className="underline-offset-2 hover:underline"
        >
          CCTP V2
        </button>
        .
      </div>

      <div className="space-y-2 rounded-xl border border-arc-border bg-white/[0.015] p-3 text-xs">
        <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">
          What changes when this ships
        </div>
        <ul className="space-y-1 text-arc-text-muted">
          <li>
            <span className="text-arc-text">One signature</span> on the source
            chain instead of two (no claim step on Arc).
          </li>
          <li>
            <span className="text-arc-text">Multi-source funding</span>:
            balances from several chains aggregate into one spendable pool.
          </li>
          <li>
            <span className="text-arc-text">Cross-chain spend</span> in a single
            call — withdraw from Arc to Ethereum / Base / Solana without
            bouncing back.
          </li>
        </ul>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-xl border border-arc-border bg-white/[0.015] p-3 text-[11px]">
        <span className="text-arc-text-muted">Reference</span>
        <Link
          href="https://docs.arc.io/app-kit/unified-balance"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-400 hover:text-sky-300"
        >
          App Kit · Unified Balance docs
        </Link>
      </div>
    </div>
  );
}
