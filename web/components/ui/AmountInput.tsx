"use client";

import { cn } from "@/lib/utils";

interface AmountInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  symbol: string;
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
          <button
            type="button"
            onClick={onMax}
            disabled={!onMax}
            className={cn("transition-colors", onMax ? "hover:text-arc-text cursor-pointer" : "cursor-default")}
          >
            {balanceLabel}
            {onMax && <span className="ml-1 text-arc-primary">MAX</span>}
          </button>
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
          <div className="rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-medium text-arc-text">{symbol}</div>
        )}
      </div>
    </div>
  );
}
