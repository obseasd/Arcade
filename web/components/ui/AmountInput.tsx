"use client";

import { TokenIcon } from "@/components/ui/TokenIcon";
import { cn } from "@/lib/utils";

interface AmountInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  symbol: string;
  /** Optional logo URL (overrides symbol-based lookup). */
  image?: string;
  balanceLabel?: string;
  onMax?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  rightAccessory?: React.ReactNode;
  className?: string;
}

export function AmountInput({
  label,
  value,
  onChange,
  symbol,
  image,
  balanceLabel,
  onMax,
  disabled,
  readOnly,
  rightAccessory,
  className,
}: AmountInputProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-arc-border bg-white/[0.015] p-4 transition-colors focus-within:border-arc-border-strong",
        className,
      )}
    >
      <div className="flex items-center justify-between text-xs text-arc-text-muted">
        <span>{label}</span>
        {balanceLabel && (
          <div className="flex items-center gap-1">
            <span>{balanceLabel}</span>
            {onMax && (
              <button
                type="button"
                onClick={onMax}
                className="rounded px-1 text-arc-primary transition-colors hover:text-arc-primary-hover"
              >
                MAX
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, "");
            const parts = v.split(".");
            if (parts.length > 2) return;
            onChange(v);
          }}
          className={cn(
            "arc-input min-w-0 flex-1 font-medium tabular-nums",
            // Auto-shrink the font as the typed amount grows so we don't
            // run out of horizontal space and clip into the ticker chip.
            // Stays at text-3xl for normal-length values, then steps down.
            sizeFromLength(value),
          )}
          aria-label="Amount"
        />
        {rightAccessory ?? (
          <div className="flex shrink-0 items-center gap-1.5 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-medium text-arc-text">
            <TokenIcon symbol={symbol} image={image} size={18} />
            {symbol}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Returns a Tailwind font-size class chosen by the typed amount's length.
 * Hand-tuned breakpoints so 18-char balances (eg "557976.127802551570")
 * stay readable instead of clipping under the ticker chip on the right.
 * Past the smallest step the native input's horizontal scroll takes over,
 * so the most recent digits stay visible while the user types.
 */
function sizeFromLength(s: string): string {
  const n = (s ?? "").length;
  if (n <= 8) return "text-3xl";
  if (n <= 12) return "text-2xl";
  if (n <= 16) return "text-xl";
  return "text-base";
}
