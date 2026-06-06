"use client";

import { Rocket, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { LaunchMode, V4_ENABLED, V4_HOOK_ENABLED } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ModeOption {
  label: string;
  mode: LaunchMode;
  /** Per-card token illustration (1448×1086, 4:3 - shown as the card cover). */
  bg: string;
}

// Display names only - the underlying contract modes are unchanged.
const MODES: ModeOption[] = [
  { label: "Pump", mode: LaunchMode.PUMP, bg: "/pumpfuntoken.png" },
  { label: "Arcade", mode: LaunchMode.CLANKER, bg: "/arctoken.png" },
  { label: "Clanker", mode: LaunchMode.CLANKER_V3, bg: "/clankertoken.png" },
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
      backdropClassName="backdrop:bg-black/30"
      className="border-arc-border bg-black/15 backdrop-blur-xl shadow-arc-card"
    >
      <div className="flex items-center justify-between border-b border-arc-border px-6 py-4">
        <h3 className="text-lg font-semibold">Launch mode</h3>
        <button type="button" onClick={onClose} className="text-arc-text-muted hover:text-arc-text">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div
        className={cn(
          "grid grid-cols-1 gap-4 p-6",
          // Dynamic column count based on which V4 surfaces are enabled.
          // 3 base modes + optional V4 prototype + optional ArcadeHook.
          V4_ENABLED && V4_HOOK_ENABLED
            ? "sm:grid-cols-5"
            : V4_ENABLED || V4_HOOK_ENABLED
              ? "sm:grid-cols-4"
              : "sm:grid-cols-3",
        )}
      >
        {MODES.map((m) => (
          <button type="button"
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
        {V4_ENABLED && (
          <button type="button"
            onClick={() => {
              onClose();
              router.push("/launchpad/v4");
            }}
            className={cn(
              "group relative flex h-44 items-end overflow-hidden rounded-2xl border border-arc-border bg-arc-surface-2/40 p-4 text-left transition-all",
              "hover:border-arc-cta-hover hover:shadow-arc-nav-glow active:scale-[0.98]",
            )}
          >
            <span className="absolute right-3 top-3 rounded-md border border-arc-primary/40 bg-arc-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-primary">
              beta
            </span>
            <div className="relative">
              <div className="text-xl font-semibold text-white">V4</div>
              <div className="mt-1 text-xs text-arc-text-muted">
                Anti-sniper hook + single-sided locked LP
              </div>
            </div>
          </button>
        )}
        {V4_HOOK_ENABLED && (
          <button type="button"
            onClick={() => {
              onClose();
              router.push("/launchpad/v4hook/create");
            }}
            className={cn(
              "group relative flex h-44 items-end overflow-hidden rounded-2xl border border-arc-cta-hover/40 p-4 text-left transition-all",
              "bg-gradient-to-br from-arc-cta/20 via-arc-surface-2/40 to-arc-cta-hover/10",
              "hover:border-arc-cta-hover hover:shadow-arc-nav-glow active:scale-[0.98]",
            )}
          >
            <span className="absolute right-3 top-3 rounded-md border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-cta-hover">
              v4 hook
            </span>
            <Rocket className="absolute right-4 top-12 h-12 w-12 text-arc-cta-hover/30 transition-transform group-hover:scale-110" />
            <div className="relative">
              <div className="text-xl font-semibold text-white">ArcadeHook</div>
              <div className="mt-1 text-xs text-arc-text-muted">
                Unified V4 hook. Atomic graduation, locked LP, royalty splits.
              </div>
            </div>
          </button>
        )}
      </div>
    </Modal>
  );
}
