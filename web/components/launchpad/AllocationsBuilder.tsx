"use client";

import { useEffect, useMemo, useState } from "react";
import { Address, isAddress } from "viem";

/**
 * Creator allocations + trustless staircase vesting, carved from the 1B launch
 * supply at createLaunch. Mirrors o1.exchange's model: each recipient gets an
 * immediate transfer or a vested (staircase) allocation held in the immutable
 * StaircaseVestingVault. The hook enforces sum(bps) <= 9000 (>=10% to the
 * market) and first unlock >= launch + 1 day; this builder enforces the same
 * client-side and emits the exact on-chain `allocations` tuple array.
 */

/** On-chain shape of one createLaunch allocation entry. */
export interface EncodedAllocation {
    recipient: Address;
    bps: number;
    steps: { unlockTime: bigint; cumulativeBps: number }[];
}

/** Max total allocation = 90% (hook MAX_ALLOC_BPS). At least 10% must stay for
 *  the curve/market. */
export const MAX_ALLOC_PCT = 90;
const MAX_STEPS = 24;
/** Confirmation buffer (seconds) added on top of "days after launch" so a first
 *  unlock of day 1 still clears the hook's `block.timestamp + 1 day` check when
 *  the tx lands a little after now. */
const LAUNCH_BUFFER_SECS = 3600;

interface StepRow {
    /** Days after launch this tranche unlocks. */
    day: string;
    /** CUMULATIVE percent unlocked by this tranche (last must be 100). */
    cumPct: string;
}

interface AllocRow {
    id: number;
    recipient: string;
    pct: string;
    vested: boolean;
    steps: StepRow[];
}

let _rowId = 1;
const newImmediateRow = (recipient = ""): AllocRow => ({
    id: _rowId++,
    recipient,
    pct: "",
    vested: false,
    steps: [],
});
const defaultSteps = (): StepRow[] => [{ day: "30", cumPct: "100" }];

export interface AllocationsResult {
    allocations: EncodedAllocation[];
    totalPct: number;
    valid: boolean;
}

interface Props {
    /** The connected wallet, offered as a one-click recipient default. */
    account?: Address;
    onChange: (result: AllocationsResult) => void;
}

export function AllocationsBuilder({ account, onChange }: Props) {
    const [rows, setRows] = useState<AllocRow[]>([]);

    const result = useMemo<AllocationsResult>(() => {
        const nowSecs = Math.floor(Date.now() / 1000) + LAUNCH_BUFFER_SECS;
        let totalPct = 0;
        let valid = true;
        const allocations: EncodedAllocation[] = [];
        let vestedCount = 0;

        for (const r of rows) {
            const pct = Number(r.pct);
            const addrOk = isAddress(r.recipient.trim());
            const pctOk = Number.isFinite(pct) && pct > 0 && pct <= 100;
            totalPct += Number.isFinite(pct) ? pct : 0;
            if (!addrOk || !pctOk) {
                valid = false;
                continue;
            }
            const bps = Math.round(pct * 100);

            let steps: { unlockTime: bigint; cumulativeBps: number }[] = [];
            if (r.vested) {
                vestedCount += 1;
                if (r.steps.length < 1 || r.steps.length > MAX_STEPS) valid = false;
                let prevDay = 0;
                let prevCum = 0;
                steps = r.steps.map((s, i) => {
                    const day = Number(s.day);
                    const cum = Number(s.cumPct);
                    const dayOk = Number.isFinite(day) && day >= 1 && (i === 0 || day > prevDay);
                    const cumOk =
                        Number.isFinite(cum) && cum > 0 && cum <= 100 && (i === 0 || cum > prevCum);
                    if (!dayOk || !cumOk) valid = false;
                    prevDay = day;
                    prevCum = cum;
                    return {
                        unlockTime: BigInt(nowSecs + Math.max(Math.floor(day), 1) * 86_400),
                        cumulativeBps: Math.round(cum * 100),
                    };
                });
                // Last tranche must reach exactly 100%.
                if (steps.length > 0 && steps[steps.length - 1].cumulativeBps !== 10_000) {
                    valid = false;
                }
            }
            allocations.push({ recipient: r.recipient.trim() as Address, bps, steps });
        }

        if (totalPct > MAX_ALLOC_PCT + 1e-9) valid = false;
        if (rows.length > 128 || vestedCount > 64) valid = false;
        // Empty is valid (no allocations = legacy full-market launch).
        return { allocations, totalPct, valid };
    }, [rows]);

    useEffect(() => {
        onChange(result);
    }, [result, onChange]);

    const patchRow = (id: number, patch: Partial<AllocRow>) =>
        setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const patchStep = (id: number, idx: number, patch: Partial<StepRow>) =>
        setRows((rs) =>
            rs.map((r) =>
                r.id === id
                    ? { ...r, steps: r.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }
                    : r,
            ),
        );

    const remaining = Math.max(0, 100 - result.totalPct);
    const over = result.totalPct > MAX_ALLOC_PCT + 1e-9;

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div>
                    <div className="text-sm font-semibold">Allocations &amp; vesting (optional)</div>
                    <div className="text-xs text-arc-text-muted">
                        Carve up to {MAX_ALLOC_PCT}% of supply to team / treasury / airdrop. The
                        rest ({remaining.toFixed(remaining % 1 ? 1 : 0)}%) seeds the market. Vested
                        allocations lock in an immutable vault: nobody (not even you) can change the
                        schedule, redirect it, or withdraw early.
                    </div>
                </div>
                <span
                    className={`shrink-0 rounded-full px-2 py-1 text-xs tabular-nums ${
                        over ? "bg-red-500/15 text-red-400" : "bg-arc-bg-elevated text-arc-text-muted"
                    }`}
                >
                    {result.totalPct.toFixed(result.totalPct % 1 ? 1 : 0)}% / {MAX_ALLOC_PCT}%
                </span>
            </div>

            {rows.map((r) => (
                <div key={r.id} className="rounded-xl border border-arc-border bg-arc-bg-elevated p-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            aria-label="Recipient address"
                            value={r.recipient}
                            onChange={(e) => patchRow(r.id, { recipient: e.target.value })}
                            placeholder="0x recipient"
                            className={`min-w-0 flex-1 rounded-lg border bg-arc-bg px-2 py-1.5 text-sm ${
                                r.recipient && !isAddress(r.recipient.trim())
                                    ? "border-red-500/50"
                                    : "border-arc-border"
                            }`}
                        />
                        <div className="flex items-center gap-1">
                            <input
                                aria-label="Percent"
                                value={r.pct}
                                onChange={(e) =>
                                    patchRow(r.id, { pct: e.target.value.replace(/[^0-9.]/g, "") })
                                }
                                inputMode="decimal"
                                placeholder="0"
                                className="w-16 rounded-lg border border-arc-border bg-arc-bg px-2 py-1.5 text-right text-sm tabular-nums"
                            />
                            <span className="text-sm text-arc-text-muted">%</span>
                        </div>
                        <button
                            type="button"
                            onClick={() =>
                                patchRow(r.id, {
                                    vested: !r.vested,
                                    steps: !r.vested ? defaultSteps() : [],
                                })
                            }
                            className={`rounded-lg border px-2.5 py-1.5 text-xs ${
                                r.vested
                                    ? "border-arc-primary/50 bg-arc-primary/10 text-arc-primary"
                                    : "border-arc-border text-arc-text-muted"
                            }`}
                        >
                            {r.vested ? "Vested" : "Immediate"}
                        </button>
                        <button
                            type="button"
                            onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
                            aria-label="Remove allocation"
                            className="rounded-lg border border-arc-border px-2 py-1.5 text-xs text-arc-text-muted hover:text-red-400"
                        >
                            ✕
                        </button>
                    </div>

                    {r.vested && (
                        <div className="mt-3 space-y-2 border-t border-arc-border pt-3">
                            <div className="text-xs text-arc-text-muted">
                                Unlock schedule (cumulative % by day after launch; last row = 100%)
                            </div>
                            {r.steps.map((s, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <span className="text-xs text-arc-text-faint">day</span>
                                    <input
                                        aria-label="Unlock day"
                                        value={s.day}
                                        onChange={(e) =>
                                            patchStep(r.id, i, {
                                                day: e.target.value.replace(/[^0-9]/g, ""),
                                            })
                                        }
                                        inputMode="numeric"
                                        className="w-16 rounded-lg border border-arc-border bg-arc-bg px-2 py-1 text-right text-sm tabular-nums"
                                    />
                                    <span className="text-xs text-arc-text-faint">→</span>
                                    <input
                                        aria-label="Cumulative percent"
                                        value={s.cumPct}
                                        onChange={(e) =>
                                            patchStep(r.id, i, {
                                                cumPct: e.target.value.replace(/[^0-9.]/g, ""),
                                            })
                                        }
                                        inputMode="decimal"
                                        className="w-16 rounded-lg border border-arc-border bg-arc-bg px-2 py-1 text-right text-sm tabular-nums"
                                    />
                                    <span className="text-xs text-arc-text-muted">% unlocked</span>
                                    {r.steps.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                patchRow(r.id, {
                                                    steps: r.steps.filter((_, x) => x !== i),
                                                })
                                            }
                                            className="ml-auto text-xs text-arc-text-faint hover:text-red-400"
                                        >
                                            remove
                                        </button>
                                    )}
                                </div>
                            ))}
                            {r.steps.length < MAX_STEPS && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        patchRow(r.id, {
                                            steps: [...r.steps, { day: "", cumPct: "100" }],
                                        })
                                    }
                                    className="text-xs text-arc-primary"
                                >
                                    + tranche
                                </button>
                            )}
                        </div>
                    )}
                </div>
            ))}

            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => setRows((rs) => [...rs, newImmediateRow()])}
                    className="rounded-lg border border-arc-border px-3 py-1.5 text-sm text-arc-text-muted hover:text-arc-text"
                >
                    + Add allocation
                </button>
                {account && (
                    <button
                        type="button"
                        onClick={() => setRows((rs) => [...rs, newImmediateRow(account)])}
                        className="rounded-lg border border-arc-border px-3 py-1.5 text-sm text-arc-text-muted hover:text-arc-text"
                    >
                        + Add my wallet
                    </button>
                )}
            </div>

            {over && (
                <div className="text-xs text-red-400">
                    Total allocation exceeds {MAX_ALLOC_PCT}%. At least 10% must seed the market.
                </div>
            )}
        </div>
    );
}
