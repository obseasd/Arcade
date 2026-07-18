"use client";

import { CrossIcon } from "@/components/ui/MaskIcon";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { LaunchMode, V4_HOOK_ENABLED } from "@/lib/constants";
import { ARCADE_HOOK_MODE } from "@/lib/abis/arcadeHook";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ModeOption {
  label: string;
  /** V4 ArcadeHook mode (0 = PUMP curve, 1 = CLANKER direct). */
  mode: number;
  /** One-line pitch shown under the card name. */
  blurb: string;
  /** Per-card token illustration (1448×1086, 4:3 - shown as the card cover). */
  bg: string;
}

// The two launch modes, both on the unified V4 ArcadeHook:
//   Pump   = bonding curve, graduates ~$60k into a locked LP.
//   Clanker = direct single-sided locked-LP launch at a chosen start mcap.
const MODES: ModeOption[] = [
  {
    label: "Pump",
    mode: ARCADE_HOOK_MODE.PUMP,
    blurb: "Bonding curve, graduates to a locked LP",
    bg: "/pumpfuntoken.png",
  },
  {
    label: "Clanker",
    mode: ARCADE_HOOK_MODE.CLANKER,
    blurb: "Direct launch, single-sided locked LP",
    bg: "/clankertoken.png",
  },
];

// Legacy V2/V3 launchpad modes (used only when the V4 hook is not configured).
const LEGACY_MODES: { label: string; mode: LaunchMode; bg: string }[] = [
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

  // V4 hook: two modes on one create page (mode preselected via ?mode=).
  const pickV4 = (mode: number) => {
    onClose();
    router.push(`/launchpad/v4hook/create?mode=${mode}`);
  };
  // Legacy V2/V3 launchpad (only when the V4 hook is not configured).
  const pickLegacy = (mode: LaunchMode) => {
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
          <CrossIcon size={20} />
        </button>
      </div>
      {V4_HOOK_ENABLED ? (
        <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
          {MODES.map((m) => (
            <button
              type="button"
              key={m.label}
              onClick={() => pickV4(m.mode)}
              className={cn(
                "group relative flex h-48 flex-col justify-end overflow-hidden rounded-2xl border border-arc-border bg-arc-surface-2/40 bg-cover bg-center p-4 text-left transition-all",
                "hover:border-arc-cta-hover hover:shadow-arc-nav-glow active:scale-[0.98]",
              )}
              style={{ backgroundImage: `url('${m.bg}')` }}
            >
              {/* Readability overlay (keeps text visible over any background). */}
              <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
              <span className="relative text-xl font-semibold text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
                {m.label}
              </span>
              <span className="relative mt-1 text-xs text-white/80 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                {m.blurb}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-3">
          {LEGACY_MODES.map((m) => (
            <button
              type="button"
              key={m.label}
              onClick={() => pickLegacy(m.mode)}
              className={cn(
                "group relative flex h-44 items-end overflow-hidden rounded-2xl border border-arc-border bg-arc-surface-2/40 bg-cover bg-center p-4 text-left transition-all",
                "hover:border-arc-cta-hover hover:shadow-arc-nav-glow active:scale-[0.98]",
              )}
              style={{ backgroundImage: `url('${m.bg}')` }}
            >
              <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
              <span className="relative text-xl font-semibold text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
                {m.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
