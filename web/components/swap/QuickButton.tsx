import { cn } from "@/lib/utils";

/**
 * Tiny inline action button used in the swap cards for 25 / 50 / 75 / MAX
 * shortcut chips. Extracted from SwapCard / LimitCard / MultiSwapCard
 * where the same 23 lines were copy-pasted (audit item 8).
 */
export function QuickButton({
    onClick,
    children,
    disabled,
}: {
    onClick?: () => void;
    children: React.ReactNode;
    disabled?: boolean;
}) {
    return (
        <button type="button"
            onClick={onClick}
            disabled={disabled || !onClick}
            className={cn(
                // Bigger touch target on mobile (~36px tall), back to compact
                // on sm: up. 36px+padding sits in the acceptable inline-action
                // range per Apple HIG.
                "rounded-md px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-all sm:px-2 sm:py-1",
                "bg-arc-surface text-arc-text-muted",
                "hover:bg-arc-cta hover:text-white",
                "active:scale-90 active:bg-arc-cta-hover",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-arc-surface disabled:hover:text-arc-text-muted",
            )}
        >
            {children}
        </button>
    );
}
