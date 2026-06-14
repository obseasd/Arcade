"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { AUTO_COMPOUNDER_ABI } from "@/lib/abis/autoCompounder";
import { ADDRESSES } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * Inline replacement for the old in-modal "Manage" form on /positions.
 *
 * Renders the Mode / Threshold / Slippage controls + Save + Stop buttons
 * for every managed position the connected wallet has IN THIS POOL. The
 * "in this pool" filter comes from comparing (token0, token1, fee) DB
 * columns returned by /api/compounder/positions against the pool tuple
 * the page reads from on-chain.
 *
 * No modal — the pool detail page is the surface where the user manages
 * the position end-to-end. The "Manage" button on the /positions card now
 * navigates here instead of opening a modal.
 *
 * Soft-fails on every dependency: no account, no /api/compounder DB, no
 * managed positions in this pool — render nothing. The pool page stays
 * usable as the generic "swap + add liquidity" surface for everyone else.
 */
export interface PoolAutoManagementInlineProps {
    poolToken0?: Address;
    poolToken1?: Address;
    poolFeePip?: number;
}

type Mode = "NORMAL" | "RECEIVE" | "COMPOUND";

interface ManagedPositionRow {
    tokenId: bigint;
    mode: Mode;
    minFeeMicros: bigint;
    maxSlippageBps: number;
}

export function PoolAutoManagementInline({
    poolToken0,
    poolToken1,
    poolFeePip,
}: PoolAutoManagementInlineProps) {
    const { address: account } = useAccount();
    const { writeContractAsync } = useWriteContract();
    const compounderEnabled =
        ADDRESSES.autoCompounder !== "0x0000000000000000000000000000000000000000";

    const [rows, setRows] = useState<ManagedPositionRow[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);
    const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!account || !compounderEnabled) {
                setRows([]);
                return;
            }
            if (!poolToken0 || !poolToken1 || poolFeePip === undefined) {
                setRows([]);
                return;
            }
            try {
                const apiRes = await fetch(
                    `/api/compounder/positions?owner=${account}`,
                );
                if (!apiRes.ok) {
                    if (!cancelled) setRows([]);
                    return;
                }
                const data = (await apiRes.json()) as {
                    positions?: {
                        tokenId: string;
                        mode: string;
                        minFeeMicros?: string;
                        maxSlippageBps?: number;
                        token0Address?: string | null;
                        token1Address?: string | null;
                        feeTier?: number | null;
                    }[];
                };
                const positions = Array.isArray(data.positions)
                    ? data.positions
                    : [];
                const ourT0 = poolToken0.toLowerCase();
                const ourT1 = poolToken1.toLowerCase();
                const matched: ManagedPositionRow[] = [];
                for (const p of positions) {
                    if (
                        p.mode !== "NORMAL" &&
                        p.mode !== "RECEIVE" &&
                        p.mode !== "COMPOUND"
                    ) {
                        continue;
                    }
                    if (
                        !p.token0Address ||
                        !p.token1Address ||
                        p.feeTier === null ||
                        p.feeTier === undefined
                    ) {
                        continue;
                    }
                    if (p.feeTier !== poolFeePip) continue;
                    const theirT0 = p.token0Address.toLowerCase();
                    const theirT1 = p.token1Address.toLowerCase();
                    const sameOrFlipped =
                        (ourT0 === theirT0 && ourT1 === theirT1) ||
                        (ourT0 === theirT1 && ourT1 === theirT0);
                    if (!sameOrFlipped) continue;
                    matched.push({
                        tokenId: BigInt(p.tokenId),
                        mode: p.mode as Mode,
                        minFeeMicros: p.minFeeMicros
                            ? BigInt(p.minFeeMicros)
                            : 100_000n,
                        maxSlippageBps: p.maxSlippageBps ?? 50,
                    });
                }
                if (!cancelled) setRows(matched);
            } catch {
                if (!cancelled) setRows([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [
        account,
        compounderEnabled,
        poolToken0,
        poolToken1,
        poolFeePip,
        refreshKey,
    ]);

    if (!account || !compounderEnabled) return null;
    if (rows.length === 0) {
        // Use a silent return rather than a hint banner; the user arrives
        // at /pool/<addr> for many reasons (swap, add liq, view chart)
        // and a "no managed position here" banner would be noise.
        return null;
    }

    return (
        <section className="mt-4 space-y-3">
            <h2 className="text-lg font-semibold text-arc-text">
                Auto-management
            </h2>
            {rows.map((row) => (
                <ManagedRowCard
                    key={row.tokenId.toString()}
                    row={row}
                    onSaved={bumpRefresh}
                    writeContractAsync={writeContractAsync}
                />
            ))}
        </section>
    );
}

function ManagedRowCard({
    row,
    onSaved,
    writeContractAsync,
}: {
    row: ManagedPositionRow;
    onSaved: () => void;
    writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"];
}) {
    const [mode, setMode] = useState<Mode>(row.mode);
    const initialThresholdStr = useMemo(
        () => (Number(row.minFeeMicros) / 1_000_000).toFixed(2),
        [row.minFeeMicros],
    );
    const initialSlippageStr = useMemo(
        () => (row.maxSlippageBps / 100).toFixed(2),
        [row.maxSlippageBps],
    );
    const [thresholdUsdc, setThresholdUsdc] = useState(initialThresholdStr);
    const [slippagePct, setSlippagePct] = useState(initialSlippageStr);
    const [saving, setSaving] = useState(false);
    const [stopping, setStopping] = useState(false);

    const thresholdMicros = useMemo(() => {
        const parsed = Number(thresholdUsdc);
        if (!Number.isFinite(parsed) || parsed < 0) return 0n;
        return BigInt(Math.floor(parsed * 1_000_000));
    }, [thresholdUsdc]);
    const slippageBps = useMemo(() => {
        const parsed = Number(slippagePct);
        if (!Number.isFinite(parsed) || parsed < 0) return 50;
        return Math.min(10_000, Math.floor(parsed * 100));
    }, [slippagePct]);

    const modeId = mode === "RECEIVE" ? 1 : mode === "COMPOUND" ? 2 : 0;

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            await writeContractAsync({
                address: ADDRESSES.autoCompounder,
                abi: AUTO_COMPOUNDER_ABI,
                functionName: "setMode",
                args: [row.tokenId, modeId, thresholdMicros, slippageBps],
            });
            onSaved();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[pool-page] setMode failed:", err);
        } finally {
            setSaving(false);
        }
    }, [
        writeContractAsync,
        row.tokenId,
        modeId,
        thresholdMicros,
        slippageBps,
        onSaved,
    ]);

    const handleStop = useCallback(async () => {
        setStopping(true);
        try {
            await writeContractAsync({
                address: ADDRESSES.autoCompounder,
                abi: AUTO_COMPOUNDER_ABI,
                functionName: "withdrawPosition",
                args: [row.tokenId],
            });
            onSaved();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[pool-page] withdrawPosition failed:", err);
        } finally {
            setStopping(false);
        }
    }, [writeContractAsync, row.tokenId, onSaved]);

    const busy = saving || stopping;

    return (
        <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-5">
            <div className="mb-4 flex items-center justify-between">
                <div className="text-sm text-arc-text-muted">
                    NFT #{row.tokenId.toString()}
                </div>
            </div>

            <div className="mb-4">
                <label className="mb-2 block text-xs uppercase tracking-wider text-arc-text-muted">
                    Mode
                </label>
                <div className="grid grid-cols-3 gap-2">
                    {(
                        [
                            { id: "NORMAL" as const, title: "Normal", body: "Tracked, no actions." },
                            { id: "RECEIVE" as const, title: "Auto-receive", body: "Push fees to wallet." },
                            { id: "COMPOUND" as const, title: "Auto-compound", body: "Reinvest into position." },
                        ] as const
                    ).map((opt) => {
                        const active = mode === opt.id;
                        return (
                            <button
                                key={opt.id}
                                type="button"
                                onClick={() => setMode(opt.id)}
                                disabled={busy}
                                className={cn(
                                    "rounded-xl border p-3 text-left text-xs transition-colors",
                                    active
                                        ? "border-sky-400 bg-sky-400/5"
                                        : "border-arc-border bg-white/[0.015] hover:border-arc-border-strong",
                                )}
                            >
                                <div className="font-semibold text-arc-text">{opt.title}</div>
                                <div className="mt-1 text-[10px] text-arc-text-muted">{opt.body}</div>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-3">
                <div>
                    <label className="mb-2 block text-xs uppercase tracking-wider text-arc-text-muted">
                        Threshold (USDC)
                    </label>
                    <input
                        type="text"
                        inputMode="decimal"
                        value={thresholdUsdc}
                        onChange={(e) => setThresholdUsdc(e.target.value)}
                        disabled={busy}
                        className="w-full rounded-xl border border-arc-border bg-white/[0.015] p-3 text-sm text-arc-text outline-none focus:border-arc-primary"
                    />
                </div>
                <div>
                    <label className="mb-2 block text-xs uppercase tracking-wider text-arc-text-muted">
                        Slippage (%)
                    </label>
                    <input
                        type="text"
                        inputMode="decimal"
                        value={slippagePct}
                        onChange={(e) => setSlippagePct(e.target.value)}
                        disabled={busy}
                        className="w-full rounded-xl border border-arc-border bg-white/[0.015] p-3 text-sm text-arc-text outline-none focus:border-arc-primary"
                    />
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={() => void handleStop()}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-arc-warn/40 bg-arc-warn/10 px-4 py-2 text-sm font-semibold text-arc-warn transition-colors hover:bg-arc-warn/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {stopping ? "Stopping…" : "Stop position"}
                </button>
                <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={busy}
                    className="arc-button-primary px-5 py-2 text-sm"
                >
                    {saving ? "Saving…" : "Save"}
                </button>
            </div>
        </div>
    );
}
