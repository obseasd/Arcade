import { BridgeCard } from "@/components/bridge/BridgeCard";
import { BridgeHistory } from "@/components/bridge/BridgeHistory";

export const metadata = {
  title: "Bridge - Arcade",
};

export default function BridgePage() {
  return (
    <div className="mx-auto max-w-[490px] px-4 py-20 sm:px-6">
      <BridgeCard />
      {/* Recent bridges from localStorage. Self-hides when empty. */}
      <BridgeHistory />
    </div>
  );
}
