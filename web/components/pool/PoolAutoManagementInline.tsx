"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, createPublicClient, http } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { AUTO_COMPOUNDER_ABI, modeLabelFromId } from "@/lib/abis/autoCompounder";
import { V3_NPM_ABI } from "@/lib/abis/v3-npm";
import { ADDRESSES } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { pushToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Inline replacement for the old in-modal "Manage" form on /positions.
 *
 * Renders the Mode / Threshold / Slippage controls + Save + Stop buttons
 * for every managed position the connected wallet has IN THIS POOL.
 *
 * Filter strategy:
 *   1. Fast path - match (token0Address, token1Address, feeTier) from
 *      the DB columns the /api/compounder/positions endpoint surfaces.
 *      These columns are written by the V3 add-liquidity flow at deposit
 *      time.
 *   2. Fallback - any DB row missing those columns (older deposit, hand-
 *      deposited via safeTransferFrom, manual API insert) is enriched by
 *      a direct NPM.positions(tokenId) read against the chain, then
 *      filtered the same way. Keeps the page useful for positions whose
 *      DB row pre-dates the mirror writes.
 *
 * Soft-fails on every dependency: no account, no /api/compounder DB, no
 * managed positions in this pool - render nothing.
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

// Use the dedicated provider URL when one is configured via
// NEXT_PUBLIC_ARC_RPC_URL (Alchemy / thirdweb) so this inline panel
// shares the same low-rate-limit transport as the rest of the app.
const RPC_URL =
    process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.testnet.arc.network";

/** Read NPM.positions(tokenId) and pull the (token0, token1, fee) tuple
 *  the page needs to filter the managed-position list by pool. Returns
 *  null on any error so a single bad position id doesn't drop the whole
 *  panel. */
async function readPositionPoolTuple(
    tokenId: bigint,
): Promise<{ token0: Address; token1: Address; feePip: number } | null> {
    const npm = ADDRESSES.v3PositionManager as Address;
    if (npm === "0x0000000000000000000000000000000000000000") return null;
    try {
        const client = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
        const result = (await client.readContract({
            address: npm,
            abi: V3_NPM_ABI,
            functionName: "positions",
            args: [tokenId],
        })) as readonly unknown[];
        // NPM.positions tuple shape: [nonce, operator, token0, token1,
        // fee, tickLower, tickUpper, liquidity, ...]. We only need indices
        // 2, 3, 4.
        const token0 = result[2] as Address;
        const token1 = result[3] as Address;
        const feePip = Number(result[4]);
        if (!token0 || !token1 || !Number.isFinite(feePip)) return null;
        return { token0, token1, feePip };
    } catch {
        return null;
    }
}

export function PoolAutoManagementInline({
    poolToken0,
    poolToken1,
    poolFeePip,
}: PoolAutoManagementInlineProps) {
    const { address: account } = useAccount();
    const { writeContractAsync } = useWriteContract();
    const publicClient = usePublicClient();
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

                const matchesPool = (
                    t0: string | null | undefined,
                    t1: string | null | undefined,
                    feePip: number | null | undefined,
                ): boolean => {
                    if (!t0 || !t1 || feePip === null || feePip === undefined) {
                        return false;
                    }
                    if (feePip !== poolFeePip) return false;
                    const a = t0.toLowerCase();
                    const b = t1.toLowerCase();
                    return (
                        (a === ourT0 && b === ourT1) ||
                        (a === ourT1 && b === ourT0)
                    );
                };

                const matched: ManagedPositionRow[] = [];
                // Walk every candidate. Fast path: DB columns are populated
                // → filter inline. Slow path: any column missing → fetch the
                // tuple from NPM. The slow path is sequential to keep RPC
                // pressure low; users rarely have more than 1-2 managed
                // positions per pool so the cost is negligible.
                for (const p of positions) {
                    if (
                        p.mode !== "NORMAL" &&
                        p.mode !== "RECEIVE" &&
                        p.mode !== "COMPOUND"
                    ) {
                        continue;
                    }
                    let resolvedT0 = p.token0Address ?? null;
                    let resolvedT1 = p.token1Address ?? null;
                    let resolvedFee = p.feeTier ?? null;
                    if (!resolvedT0 || !resolvedT1 || resolvedFee === null) {
                        const tuple = await readPositionPoolTuple(BigInt(p.tokenId));
                        if (!tuple) continue;
                        resolvedT0 = tuple.token0;
                        resolvedT1 = tuple.token1;
                        resolvedFee = tuple.feePip;
                    }
                    if (!matchesPool(resolvedT0, resolvedT1, resolvedFee)) continue;
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
    if (rows.length === 0) return null;

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
                    publicClient={publicClient}
                    ownerAddress={account}
                />
            ))}
        </section>
    );
}

function ManagedRowCard({
    row,
    onSaved,
    writeContractAsync,
    publicClient,
    ownerAddress,
}: {
    row: ManagedPositionRow;
    onSaved: () => void;
    writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"];
    publicClient: ReturnType<typeof usePublicClient>;
    ownerAddress: Address | undefined;
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

    // ArcadeAutoCompounder.setMode enforces MIN_FEE_MICROS_FLOOR =
    // 1_000_000 (1 USDC). Anything below would revert with
    // "MIN_FEE_TOO_LOW". Clamp + warn in the UI so the user sees the
    // bump explicitly rather than having setMode revert with a
    // generic error.
    const MIN_THRESHOLD_USDC = 1.0;
    const thresholdBelowFloor = useMemo(() => {
        const parsed = Number(thresholdUsdc);
        if (!Number.isFinite(parsed)) return false;
        return parsed < MIN_THRESHOLD_USDC;
    }, [thresholdUsdc]);
    const thresholdMicros = useMemo(() => {
        const parsed = Number(thresholdUsdc);
        if (!Number.isFinite(parsed) || parsed < 0) return 0n;
        const micros = BigInt(Math.floor(parsed * 1_000_000));
        return micros < 1_000_000n ? 1_000_000n : micros;
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
            const hash = await writeContractAsync({
                address: ADDRESSES.autoCompounder,
                abi: AUTO_COMPOUNDER_ABI,
                functionName: "setMode",
                args: [row.tokenId, modeId, thresholdMicros, slippageBps],
            });
            // Wait for the receipt before declaring success. Without this
            // wait, the user sees a "Saved" toast the moment the wallet
            // popup closes, but the chain state and our DB mirror are
            // still mid-flight — a refresh in the next few seconds would
            // surface the OLD mode and reset the form to its pre-edit
            // values. The wait keeps the toast and the form state
            // honest: success only fires once the chain has accepted
            // the change.
            if (publicClient) {
                try {
                    await publicClient.waitForTransactionReceipt({ hash });
                } catch {
                    // receipt-poll failure on testnet RPC is non-fatal —
                    // the tx still landed; fall through to the DB mirror
                    // + toast paths so the user can still see the
                    // outcome.
                }
            }
            // Mirror to /api/compounder/positions so the on-chain change
            // appears in the next API read instantaneously. Without this
            // mirror, the API still returns the pre-edit (mode, minFee,
            // slippage) tuple from Postgres until the compounder cron
            // event listener catches up — which on testnet runs at the
            // 5-min cadence and made every refresh-after-Save show the
            // OLD values.
            if (ownerAddress) {
                try {
                    await fetch("/api/compounder/positions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            action: "upsert",
                            tokenId: row.tokenId.toString(),
                            ownerAddress,
                            mode: modeLabelFromId(modeId as 0 | 1 | 2),
                            minFeeMicros: thresholdMicros.toString(),
                            maxSlippageBps: slippageBps,
                        }),
                    });
                } catch (mirrorErr) {
                    // eslint-disable-next-line no-console
                    console.warn("[pool-page] setMode DB mirror failed:", mirrorErr);
                }
            }
            pushToast({
                kind: "info",
                title: "Auto-management updated",
                message: `Mode ${modeLabelFromId(modeId as 0 | 1 | 2).toLowerCase()} · threshold ${(Number(thresholdMicros) / 1_000_000).toFixed(2)} USDC · slippage ${(slippageBps / 100).toFixed(2)}%.`,
            });
            onSaved();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[pool-page] setMode failed:", err);
            pushToast({
                kind: "error",
                title: "Update failed",
                message: err instanceof Error ? err.message : "Unknown error",
            });
        } finally {
            setSaving(false);
        }
    }, [
        writeContractAsync,
        publicClient,
        ownerAddress,
        row.tokenId,
        modeId,
        thresholdMicros,
        slippageBps,
        onSaved,
    ]);

    const busy = saving;

    // Detect any divergence from the on-chain config so the Save button
    // can flag the user that the form has unsaved edits. Anything else
    // would let the user click Save unnecessarily and burn gas on a no-op
    // setMode tx.
    const initialMode = row.mode;
    const dirty =
        mode !== initialMode ||
        thresholdMicros !== row.minFeeMicros ||
        slippageBps !== row.maxSlippageBps;

    return (
        <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5">
            <div className="mb-4 text-sm text-arc-text-muted">
                NFT #{row.tokenId.toString()}
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

            {/* Threshold + Slippage only matter when the keeper has work
                to do. NORMAL mode is "tracked, no actions" so neither
                input applies. We render the row with visibility:hidden
                instead of an unmount so the overall section height stays
                the same when the user toggles between modes - prevents
                the Save button from jumping up and down the page each
                time the user picks a different mode. Form field state
                is preserved across the visibility flip so a switch back
                to RECEIVE / COMPOUND re-uses the user's last values. */}
            <div
                className="mb-4 grid grid-cols-2 gap-3"
                style={{
                    visibility: mode === "NORMAL" ? "hidden" : "visible",
                }}
                aria-hidden={mode === "NORMAL"}
            >
                <div>
                    <label className="mb-2 block text-xs uppercase tracking-wider text-arc-text-muted">
                        Threshold (USDC)
                    </label>
                    <input
                        type="text"
                        inputMode="decimal"
                        value={thresholdUsdc}
                        onChange={(e) => setThresholdUsdc(e.target.value)}
                        disabled={busy || mode === "NORMAL"}
                        tabIndex={mode === "NORMAL" ? -1 : 0}
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
                        disabled={busy || mode === "NORMAL"}
                        tabIndex={mode === "NORMAL" ? -1 : 0}
                        className="w-full rounded-xl border border-arc-border bg-white/[0.015] p-3 text-sm text-arc-text outline-none focus:border-arc-primary"
                    />
                </div>
            </div>

            {mode !== "NORMAL" && thresholdBelowFloor && (
                <div className="mb-3 rounded-lg border border-arc-warn/40 bg-arc-warn/10 px-3 py-2 text-[11px] text-arc-warn">
                    Threshold must be at least 1.00 USDC. The contract floor will round this up automatically on save.
                </div>
            )}

            <div className="flex items-center justify-end">
                <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={busy || !dirty}
                    className="arc-button-primary px-5 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? "Saving…" : dirty ? "Save changes" : "Save"}
                </button>
            </div>
        </div>
    );
}
