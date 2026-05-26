import { SwapCard } from "@/components/swap/SwapCard";

export const metadata = {
  title: "Swap — Arcade",
};

export default function SwapPage() {
  return (
    <div className="mx-auto max-w-[490px] px-4 py-20 sm:px-6">
      <SwapCard />
    </div>
  );
}
