"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { LaunchMode } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ModeOption {
  label: string;
  mode: LaunchMode;
  /** Per-card background image (drop a file at this path to style it). */
  bg: string;
}

// Display names only — the underlying contract modes are unchanged.
const MODES: ModeOption[] = [
  { label: "Pump", mode: LaunchMode.PUMP, bg: "/launch-pump.png" },
  { label: "Arcade", mode: LaunchMode.CLANKER, bg: "/launch-arcade.png" },
  { label: "Clanker", mode: LaunchMode.CLANKER_V3, bg: "/launch-clanker.png" },
];

/**
 * Horizontal launch-mode picker. Opens from "Launch a token"; once a mode is
 * chosen the user is routed to the create form with that mode preselected.
 * Cards show only the mode name (backgrounds are designed per card).
 */
export function LaunchModeModal({ open, onClose }: Props) {
  const router = useRouter();

  const pick = (mode: LaunchMode) => {
    onClose();
    router.push(`/launchpad/create?mode=${mode}`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClassName="max-w-3xl"
      backdropClassName="bg-black/30"
      className="border-arc-border bg-black/15 backdrop-blur-xl shadow-arc-card"
    >
      <div className="flex items-center justify-between border-b border-arc-border px-6 py-4">
        <h3 className="text-lg font-semibold">Launch mode</h3>
        <button onClick={onClose} className="text-arc-text-muted hover:text-arc-text">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-3">
        {MODES.map((m) => (
          <button
            key={m.label}
            onClick={() => pick(m.mode)}
            className={cn(
              "group relative flex h-44 items-end overflow-hidden rounded-2xl border border-arc-border bg-arc-surface-2/40 bg-cover bg-center p-4 text-left transition-all",
              "hover:border-arc-cta-hover hover:shadow-arc-nav-glow active:scale-[0.98]",
            )}
            style={{ backgroundImage: `url('${m.bg}')` }}
          >
            {/* Readability overlay (keeps the name visible over any background). */}
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
            <span className="relative text-xl font-semibold text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
              {m.label}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
