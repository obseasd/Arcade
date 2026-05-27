"use client";

import { Plus, X } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { AddLiquidityCard } from "@/components/pool/AddLiquidityCard";
import { MyPositions } from "@/components/pool/MyPositions";
import { BurnedPositions } from "@/components/pool/BurnedPositions";
import { CreatorFeesPanel } from "@/components/pool/CreatorFeesPanel";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";

type Tab = "amm" | "burned" | "creator" | "concentrated";

export default function PositionsPage() {
  const [newOpen, setNewOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("amm");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Hero — title + description, banner image as background */}
      <div
        className="relative mb-5 overflow-hidden rounded-3xl border border-arc-border"
        style={{
          backgroundImage: "url(/banner.png?v=2)",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        {/* Dark gradient overlay so text stays readable */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/55 to-transparent" />
        <div className="relative p-8 sm:p-10">
          <h1 className="font-display text-4xl font-semibold tracking-tight">
            Your{" "}
            <span className="bg-gradient-to-r from-arc-cta-hover to-arc-primary-hover bg-clip-text text-transparent">
              Positions
            </span>
          </h1>
          <p className="mt-2 max-w-md text-sm text-arc-text-muted">
            Manage your liquidity pools and view your positions.
          </p>
        </div>
      </div>

      {/* + New position — under the banner, right-aligned */}
      <div className="mb-6 flex justify-end">
        <button
          onClick={() => setNewOpen(true)}
          className="arc-button-primary relative overflow-hidden bg-cover bg-center bg-no-repeat px-5 py-2.5 text-base shadow-[0_10px_30px_-12px_rgba(52,90,120,0.55)] ring-1 ring-arc-cta-hover/40"
          style={{ backgroundImage: "url('/create%20token.png')" }}
        >
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/55 via-black/30 to-black/55" aria-hidden />
          <span className="relative flex items-center gap-2 font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
            <Plus className="h-4 w-4" /> New position
          </span>
        </button>
      </div>

      {/* Tabs */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <TabButton active={tab === "amm"} onClick={() => setTab("amm")}>
          Standard AMM
        </TabButton>
        <TabButton active={tab === "burned"} onClick={() => setTab("burned")}>
          Burned
        </TabButton>
        <TabButton active={tab === "creator"} onClick={() => setTab("creator")}>
          Creator fees
        </TabButton>
        <TabButton active={false} disabled label="Soon">
          Concentrated Liquidity
        </TabButton>
      </div>

      {/* Tab content */}
      {tab === "amm" && <MyPositions emptyState={<EmptyState />} />}
      {tab === "burned" && <BurnedPositions />}
      {tab === "creator" && <CreatorFeesPanel />}

      {/* New-position modal — panel matches the swap/bridge cards exactly
          (.arc-card = bg-black/15 backdrop-blur-xl) so the token rectangles
          read identically. */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        widthClassName="max-w-md"
        backdropClassName="bg-black/40 backdrop-blur-sm"
        className="border-arc-border bg-black/15 backdrop-blur-xl shadow-arc-card"
      >
        <div className="flex items-center justify-between border-b border-arc-border px-5 py-4">
          <h3 className="text-base font-semibold">New position</h3>
          <button
            onClick={() => setNewOpen(false)}
            className="rounded-lg p-1 text-arc-text-muted hover:bg-arc-surface hover:text-arc-text"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">
          <AddLiquidityCard />
        </div>
      </Modal>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  disabled,
  label,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-xl border px-4 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-arc-gray bg-arc-cta-hover text-white"
          : "border-arc-border bg-arc-surface text-arc-text-muted hover:bg-arc-surface-2 hover:text-arc-text",
        disabled && "cursor-not-allowed opacity-50 hover:bg-arc-surface hover:text-arc-text-muted",
      )}
    >
      {children}
      {label && <span className="ml-2 rounded-full bg-arc-surface-2 px-2 py-0.5 text-[10px]">{label}</span>}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="py-20 text-center">
      <Image
        src="/empty.png"
        alt=""
        width={48}
        height={48}
        className="mx-auto mb-3 h-12 w-12 opacity-50"
      />
      <p className="text-sm text-arc-text-muted">Your V2 liquidity positions will appear here.</p>
    </div>
  );
}
