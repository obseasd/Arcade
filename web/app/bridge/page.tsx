import { BridgeBalancePanel } from "@/components/bridge/BridgeBalancePanel";
import { BridgeCard } from "@/components/bridge/BridgeCard";
import { BridgeHistory } from "@/components/bridge/BridgeHistory";

/**
 * Bridge page — CCTP V2 burn-mint only. The Gateway / Unified
 * Balance preview tab was removed 2026-06-17 after live testing
 * showed the Circle SDK's testnet path was unreliable (balance
 * stayed pending indefinitely) and the spend-side wasn't wired,
 * so the feature wasn't usable end-to-end.
 */
export default function BridgePage() {
  return (
    <div className="mx-auto max-w-[490px] px-4 py-8 sm:px-6 sm:py-20">
      <BridgeBalancePanel />
      <BridgeCard />
      <BridgeHistory />
    </div>
  );
}
