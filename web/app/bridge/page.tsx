import { BridgeCard } from "@/components/bridge/BridgeCard";
import { BridgeHistory } from "@/components/bridge/BridgeHistory";

export const metadata = {
  title: "Bridge - Arcade",
};

export default function BridgePage() {
  // py-8 on mobile so the card lands near the top without a giant gap;
  // sm:py-20 keeps the desktop spacing the user is used to.
  return (
    <div className="mx-auto max-w-[490px] px-4 py-8 sm:px-6 sm:py-20">
      <BridgeCard />
      {/* Recent bridges from localStorage. Self-hides when empty. */}
      <BridgeHistory />
    </div>
  );
}
