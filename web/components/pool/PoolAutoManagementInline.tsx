"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address } from "viem";
import type { PublicClient } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { AUTO_COMPOUNDER_ABI, modeLabelFromId } from "@/lib/abis/autoCompounder";
import { V3_NPM_ABI } from "@/lib/abis/v3-npm";
import { runSequential } from "@/lib/routing/runSequential";
import { ADDRESSES } from "@/lib/constants";
import { pushToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Minimal ERC-721 approve fragment (V3_NPM_ABI's approve overload isn't
// exposed here). Used for the approve(tokenId) tx that precedes
// depositPosition (run as sequential direct txs from the user's wallet).
const ERC721_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

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
    /** Optional tokenId hint from the URL (?tokenId=N). When the user
     *  navigated here via "Manage" on a specific position card, focusing
     *  the section on THAT NFT removes the confusion of "I clicked
     *  Manage on token 5 but the section shows token 9's settings".
     *  When set and the token IS managed, only that NFT's row renders.
     *  When set but the token is NOT in the managed list, a clear
     *  "this position isn't auto-managed yet" notice renders instead
     *  of silently hiding the section. */
    focusTokenId?: string | null;
}

type Mode = "NORMAL" | "RECEIVE" | "COMPOUND";

interface ManagedPositionRow {
    tokenId: bigint;
    mode: Mode;
    minFeeMicros: bigint;
    maxSlippageBps: number;
}

async function readRowsForPool(
    client: PublicClient,
    tokenIds: bigint[],
    ourT0: string,
    ourT1: string,
    poolFeePip: number,
): Promise<Map<string, { mode: Mode; maxSlippageBps: number; minFeeMicros: bigint }>> {
    const out = new Map<
        string,
        { mode: Mode; maxSlippageBps: number; minFeeMicros: bigint }
    >();
    if (tokenIds.length === 0) return out;
    const npm = ADDRESSES.v3PositionManager as Address;
    const compounder = ADDRESSES.autoCompounder as Address;
    if (
        npm === "0x0000000000000000000000000000000000000000" ||
        compounder === "0x0000000000000000000000000000000000000000"
    ) {
        return out;
    }

    const contracts = tokenIds.flatMap((tokenId) => [
        {
            address: npm,
            abi: V3_NPM_ABI,
            functionName: "positions" as const,
            args: [tokenId] as const,
        },
        {
            address: compounder,
            abi: AUTO_COMPOUNDER_ABI,
            functionName: "configs" as const,
            args: [tokenId] as const,
        },
    ]);
    const results = (await client.multicall({
        contracts: contracts as never,
        allowFailure: true,
    })) as { status: "success" | "failure"; result: unknown }[];

    for (let i = 0; i < tokenIds.length; i++) {
        const tokenId = tokenIds[i];
        const posRes = results[i * 2];
        const cfgRes = results[i * 2 + 1];
        if (posRes?.status !== "success" || cfgRes?.status !== "success") continue;
        const pos = posRes.result as readonly unknown[];
        const cfg = cfgRes.result as readonly unknown[];
        const t0 = (pos[2] as Address).toLowerCase();
        const t1 = (pos[3] as Address).toLowerCase();
        const feePip = Number(pos[4]);
        const sameOrFlipped =
            (t0 === ourT0 && t1 === ourT1) ||
            (t0 === ourT1 && t1 === ourT0);
        if (!sameOrFlipped || feePip !== poolFeePip) continue;
        const modeId = Number(cfg[1]);
        const mode: Mode =
            modeId === 1 ? "RECEIVE" : modeId === 2 ? "COMPOUND" : "NORMAL";
        const maxSlippageBps = Number(cfg[2]);
        const minFeeMicros = BigInt(cfg[4] as bigint);
        out.set(tokenId.toString(), { mode, maxSlippageBps, minFeeMicros });
    }
    return out;
}

export function PoolAutoManagementInline({
    poolToken0,
    poolToken1,
    poolFeePip,
    focusTokenId,
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

                // First filter candidates that even have a chance of
                // matching this pool. DB-mirrored token addresses are
                // a fast filter; if the row predates the mirror
                // (resolvedT0/1 missing), we still consider it via
                // the on-chain multicall below.
                const candidateIds: bigint[] = [];
                const apiByTokenId = new Map<string, (typeof positions)[number]>();
                for (const p of positions) {
                    if (
                        p.mode !== "NORMAL" &&
                        p.mode !== "RECEIVE" &&
                        p.mode !== "COMPOUND"
                    ) {
                        continue;
                    }
                    const t0 = p.token0Address ?? null;
                    const t1 = p.token1Address ?? null;
                    const fee = p.feeTier ?? null;
                    const hasMirror = !!t0 && !!t1 && fee !== null;
                    if (hasMirror && !matchesPool(t0, t1, fee)) continue;
                    candidateIds.push(BigInt(p.tokenId));
                    apiByTokenId.set(p.tokenId, p);
                }
                // 2026-06-15 audit HIGH#7 fix: one multicall across all
                // candidates instead of 2N sequential reads with a
                // fresh PublicClient per row. The wagmi-injected
                // publicClient already inherits the Alchemy + Arc
                // public + thirdweb fallback transport and the
                // batch:{wait:50} HTTP coalescing.
                let onChainConfigs: Map<
                    string,
                    { mode: Mode; maxSlippageBps: number; minFeeMicros: bigint }
                > = new Map();
                if (publicClient && candidateIds.length > 0) {
                    onChainConfigs = await readRowsForPool(
                        publicClient as unknown as PublicClient,
                        candidateIds,
                        ourT0,
                        ourT1,
                        poolFeePip,
                    );
                }
                const matched: ManagedPositionRow[] = [];
                for (const tokenIdStr of apiByTokenId.keys()) {
                    const p = apiByTokenId.get(tokenIdStr)!;
                    const chain = onChainConfigs.get(tokenIdStr);
                    if (!chain) continue; // didn't match pool on-chain
                    matched.push({
                        tokenId: BigInt(p.tokenId),
                        mode: chain.mode,
                        minFeeMicros: chain.minFeeMicros,
                        maxSlippageBps: chain.maxSlippageBps,
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
        publicClient,
        refreshKey,
    ]);

    if (!account || !compounderEnabled) return null;

    // When focusTokenId is set, narrow the section to that NFT only and
    // surface a clear "not yet auto-managed" notice when the user came
    // from a position that isn't deposited in the compounder. Without
    // the focus filter, the user clicked Manage on token 5, landed
    // here, and saw token 9's settings - reads as "Manage shows
    // Auto-compound for my Normal position".
    if (focusTokenId) {
        const focused = rows.find((r) => r.tokenId.toString() === focusTokenId);
        if (focused) {
            return (
                <section className="mt-4 space-y-3">
                    <h2 className="text-lg font-semibold text-arc-text">
                        Auto-management
                    </h2>
                    <ManagedRowCard
                        key={focused.tokenId.toString()}
                        row={focused}
                        onSaved={bumpRefresh}
                        writeContractAsync={writeContractAsync}
                        publicClient={publicClient}
                        ownerAddress={account}
                    />
                </section>
            );
        }
        return (
            <section className="mt-4 space-y-3">
                <h2 className="text-lg font-semibold text-arc-text">
                    Auto-management
                </h2>
                <ManagedRowCard
                    row={{
                        tokenId: BigInt(focusTokenId),
                        mode: "NORMAL",
                        minFeeMicros: 1_000_000n,
                        maxSlippageBps: 50,
                    }}
                    onSaved={bumpRefresh}
                    writeContractAsync={writeContractAsync}
                    publicClient={publicClient}
                    ownerAddress={account}
                    unmanaged
                />
            </section>
        );
    }

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
    unmanaged = false,
}: {
    row: ManagedPositionRow;
    onSaved: () => void;
    writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"];
    publicClient: ReturnType<typeof usePublicClient>;
    ownerAddress: Address | undefined;
    /** True for a not-yet-deposited position: Save folds approve +
     *  depositPosition instead of calling setMode. */
    unmanaged?: boolean;
}) {
    const [mode, setMode] = useState<Mode>(unmanaged ? "RECEIVE" : row.mode);
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
    // "MIN_FEE_TOO_LOW". We clamp the displayed value to the floor on
    // blur (not on every keystroke — otherwise typing "0.5" snaps to
    // "1" the moment the user types "0") and ALSO clamp the bigint
    // we pass to setMode so a fat-finger that somehow bypasses the
    // blur still won't revert. No banner anymore: the snap-on-blur is
    // visible and unambiguous, the banner was just noise.
    const MIN_THRESHOLD_USDC = 1.0;
    const onThresholdBlur = useCallback(() => {
        const parsed = Number(thresholdUsdc);
        if (!Number.isFinite(parsed) || parsed < MIN_THRESHOLD_USDC) {
            setThresholdUsdc(MIN_THRESHOLD_USDC.toFixed(2));
        }
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
            let hash: `0x${string}`;
            if (unmanaged) {
                // Depositing an un-managed position. Arc's callFrom
                // precompile is dead, so the old "approve + deposit in one
                // signature" Multicall3From batch reverts on-chain. Run the
                // ERC-721 approve(tokenId) then depositPosition as two
                // direct txs from the user's wallet (msg.sender is the user
                // on each). thresholdMicros is already clamped to the
                // 1-USDC floor above, so this can't hit MIN_FEE_TOO_LOW.
                const last = await runSequential(
                    [
                        {
                            address: ADDRESSES.v3PositionManager,
                            abi: ERC721_APPROVE_ABI,
                            functionName: "approve",
                            args: [ADDRESSES.autoCompounder as Address, row.tokenId],
                        },
                        {
                            address: ADDRESSES.autoCompounder as Address,
                            abi: AUTO_COMPOUNDER_ABI,
                            functionName: "depositPosition",
                            args: [row.tokenId, modeId, thresholdMicros, slippageBps],
                        },
                    ],
                    { writeContractAsync, publicClient },
                );
                hash = last as `0x${string}`;
            } else {
                hash = await writeContractAsync({
                    address: ADDRESSES.autoCompounder,
                    abi: AUTO_COMPOUNDER_ABI,
                    functionName: "setMode",
                    args: [row.tokenId, modeId, thresholdMicros, slippageBps],
                });
            }
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
                title: unmanaged
                    ? "Position under auto-management"
                    : "Auto-management updated",
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
        unmanaged,
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
                        onBlur={onThresholdBlur}
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

            <div className="flex items-center justify-end">
                <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={busy || (!unmanaged && !dirty)}
                    className="arc-button-primary px-5 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving
                        ? unmanaged
                            ? "Depositing…"
                            : "Saving…"
                        : unmanaged
                          ? "Enable auto-management"
                          : dirty
                            ? "Save changes"
                            : "Save"}
                </button>
            </div>
        </div>
    );
}
