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
          className="arc-input flex-1 text-3xl font-medium"
        />
        {rightAccessory ?? (
          <div className="flex items-center gap-1.5 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-medium text-arc-text">
            <TokenIcon symbol={symbol} image={image} size={18} />
            {symbol}
          </div>
        )}
      </div>
    </div>
  );
}
