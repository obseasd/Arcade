import { BridgeCard } from "@/components/bridge/BridgeCard";
import { BridgeHistory } from "@/components/bridge/BridgeHistory";

/**
 * Bridge page. EVM <-> Arc runs through the audited CCTP BridgeCard;
 * Solana <-> Arc is selectable directly in the chain picker (the card
 * branches to the Circle App Kit flow when a side is Solana).
 */
export default function BridgePage() {
  return (
    <div className="mx-auto max-w-[490px] px-4 py-8 sm:px-6 sm:py-20">
      <BridgeCard />
      <BridgeHistory />
    </div>
  );
}
