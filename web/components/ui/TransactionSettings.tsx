"use client";

import { HelpCircle } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface Props {
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
    /** Slippage tolerance in basis points (1 bp = 0.01%). */
    slippageBps: number;
    /** Custom-input mirror string ("" when a preset is selected). */
    slippageCustom: string;
    onPreset: (bps: number) => void;
    onCustom: (str: string) => void;
    /** Optional transaction deadline minutes (omit to hide the row). */
    deadlineMin?: number;
    onDeadlineChange?: (mins: number) => void;
    presets?: number[];
}

const DEFAULT_PRESETS_BPS = [10, 50, 100];

/**
 * Slippage + (optional) deadline popover. Shared between SwapCard and the
 * pool-add surfaces so the UX is identical across the app: same gear icon
 * (the brand slider.png), same preset chip / custom-input layout, same
 * outside-click + Escape close behaviour. Pool-add wires `deadlineMin` to
 * render a second row; Swap leaves it undefined.
 */
export function TransactionSettings({
    open,
    onToggle,
    onClose,
    slippageBps,
    slippageCustom,
    onPreset,
    onCustom,
    deadlineMin,
    onDeadlineChange,
    presets = DEFAULT_PRESETS_BPS,
}: Props) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [open, onClose]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    return (
        <div ref={ref} className="relative">
            <button
                onClick={onToggle}
                aria-expanded={open}
                className={cn(
                    "rounded-lg p-2 transition-colors",
                    open
                        ? "bg-arc-surface-2 text-arc-text"
                        : "text-arc-text-muted hover:bg-arc-surface hover:text-arc-text",
                )}
            >
                <Image
                    src="/slider.png"
                    alt="Settings"
                    width={18}
                    height={18}
                    className="h-4 w-4 opacity-80"
                />
            </button>
            {open && (
                <div className="absolute right-0 top-full z-20 mt-2 w-72 max-w-[calc(100vw-1rem)] rounded-2xl border border-arc-border bg-black/45 p-4 shadow-arc-card backdrop-blur-2xl">
                    <div className="mb-3 text-sm font-semibold text-arc-text">
                        Transaction settings
                    </div>
                    <div className="mb-2 flex items-center gap-1.5 text-xs text-arc-text-muted">
                        Slippage tolerance
                        <HelpCircle className="h-3 w-3" />
                    </div>
                    <div className="flex items-center gap-1.5">
                        {presets.map((bps) => {
                            const active = slippageCustom === "" && slippageBps === bps;
                            return (
                                <button
                                    key={bps}
                                    onClick={() => onPreset(bps)}
                                    className={cn(
                                        "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                                        active
                                            ? "bg-arc-cta text-white"
                                            : "bg-arc-surface text-arc-text-muted hover:bg-arc-surface-2 hover:text-arc-text",
                                    )}
                                >
                                    {bps / 100}%
                                </button>
                            );
                        })}
                        <div
                            className={cn(
                                "ml-auto flex items-center gap-0.5 rounded-full border px-2.5 py-1 transition-colors",
                                slippageCustom !== ""
                                    ? "border-arc-cta bg-arc-bg"
                                    : "border-arc-border bg-arc-surface",
                            )}
                        >
                            <input
                                type="text"
                                inputMode="decimal"
                                value={slippageCustom}
                                onChange={(e) => onCustom(e.target.value)}
                                placeholder="0.50"
                                className="arc-input w-10 text-right text-xs"
                            />
                            <span className="text-[10px] text-arc-text-muted">%</span>
                        </div>
                    </div>
                    {slippageBps > 500 && (
                        <div className="mt-3 rounded-lg border border-arc-warn/30 bg-arc-warn/10 p-2 text-[11px] text-arc-warn">
                            High slippage - your trade may be front-run.
                        </div>
                    )}
                    {deadlineMin !== undefined && onDeadlineChange && (
                        <>
                            <div className="mt-4 mb-2 flex items-center gap-1.5 text-xs text-arc-text-muted">
                                Transaction deadline
                                <HelpCircle className="h-3 w-3" />
                            </div>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    min={1}
                                    max={120}
                                    value={deadlineMin}
                                    onChange={(e) => {
                                        const n = Math.max(1, Math.min(120, Number(e.target.value) || 20));
                                        onDeadlineChange(n);
                                    }}
                                    className="w-20 rounded-lg border border-arc-border bg-arc-surface px-3 py-1.5 text-right text-xs text-arc-text"
                                />
                                <span className="text-xs text-arc-text-muted">minutes</span>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
