"use client";

import { CheckCircle2, Info, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, zeroAddress } from "viem";
import {
    useAccount,
    usePublicClient,
    useReadContract,
    useReadContracts,
    useWriteContract,
} from "wagmi";

import { V3_FACTORY_ABI, V3_NPM_ABI, V3_POOL_ABI } from "@/lib/abis/v3-npm";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { Modal } from "@/components/ui/Modal";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { pushToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const USDC_LOWER = ADDRESSES.usdc.toLowerCase();
const MAX_UINT128 = (1n << 128n) - 1n;

interface Props {
    open: boolean;
    onClose: () => void;
    onSuccess?: () => void;
}

/**
 * Claim all unclaimed V3 fees across the user's positions. Hyperswap-style
 * modal: list every position with a selectable card, "Select all / Clear"
 * affordance, gas estimate denominated in USDC (Arc's native gas token),
 * and a single Claim button that fires NPM.collect for each selected
 * position. Closes itself after the broadcast cluster lands so the user
 * doesn't have to dismiss it manually.
 *
 * Auto-pre-selects positions with non-zero tokensOwed - the user typically
 * wants to claim every accruing position at once, but the per-row toggle
 * stays available for fine control.
 */
export function ClaimAllFeesModal({ open, onClose, onSuccess }: Props) {
    const { address: account } = useAccount();
    const publicClient = usePublicClient();
    const { writeContractAsync } = useWriteContract();
    const npmEnabled = ADDRESSES.v3PositionManager !== zeroAddress;

    const balanceQ = useReadContract({
        address: ADDRESSES.v3PositionManager,
        abi: V3_NPM_ABI,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account && npmEnabled && open },
    });
    const count = Number((balanceQ.data as bigint | undefined) ?? 0n);

    const tokenIdsQ = useReadContracts({
        contracts:
            account && npmEnabled
                ? Array.from({ length: count }, (_, i) => ({
                      address: ADDRESSES.v3PositionManager,
                      abi: V3_NPM_ABI,
                      functionName: "tokenOfOwnerByIndex" as const,
                      args: [account, BigInt(i)] as const,
                  }))
                : [],
        query: { enabled: !!account && npmEnabled && count > 0 && open },
    });
    const tokenIds = useMemo(
        () =>
            (tokenIdsQ.data ?? [])
                .map((c) => (c.status === "success" ? (c.result as bigint) : undefined))
                .filter((x): x is bigint => x !== undefined),
        [tokenIdsQ.data],
    );

    const positionsQ = useReadContracts({
        contracts: tokenIds.map((id) => ({
            address: ADDRESSES.v3PositionManager,
            abi: V3_NPM_ABI,
            functionName: "positions" as const,
            args: [id] as const,
        })),
        query: { enabled: tokenIds.length > 0 && open },
    });

    type RawPosition = readonly [
        bigint,
        Address,
        Address,
        Address,
        number,
        number,
        number,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
    ];

    const positions = useMemo(() => {
        return (positionsQ.data ?? [])
            .map((c, i) => {
                if (c.status !== "success") return undefined;
                const r = c.result as RawPosition;
                return {
                    tokenId: tokenIds[i],
                    token0: r[2],
                    token1: r[3],
                    fee: Number(r[4]),
                    tickLower: Number(r[5]),
                    tickUpper: Number(r[6]),
                    liquidity: r[7],
                    tokensOwed0: r[10],
                    tokensOwed1: r[11],
                };
            })
            .filter((x): x is NonNullable<typeof x> => x !== undefined);
    }, [positionsQ.data, tokenIds]);

    // Pool slot0 per position so we can show the in-range badge in the
    // selection card. Multicalled in one go.
    const poolAddrQ = useReadContracts({
        contracts: positions.map((p) => ({
            address: ADDRESSES.v3Factory,
            abi: V3_FACTORY_ABI,
            functionName: "getPool" as const,
            args: [p.token0, p.token1, p.fee] as const,
        })),
        query: { enabled: positions.length > 0 && open },
    });
    const poolAddrs = useMemo(
        () =>
            (poolAddrQ.data ?? []).map((r) =>
                r.status === "success" ? (r.result as Address) : undefined,
            ),
        [poolAddrQ.data],
    );
    const slot0Q = useReadContracts({
        contracts: poolAddrs
            .filter((a): a is Address => !!a)
            .map((a) => ({ address: a, abi: V3_POOL_ABI, functionName: "slot0" as const })),
        query: { enabled: poolAddrs.some((a) => !!a) && open },
    });
    const slot0ByPool = useMemo(() => {
        const m = new Map<string, { tick: number }>();
        const live = poolAddrs.filter((a): a is Address => !!a);
        slot0Q.data?.forEach((r, i) => {
            if (r.status !== "success") return;
            const tup = r.result as readonly [bigint, number, ...unknown[]];
            m.set(live[i].toLowerCase(), { tick: Number(tup[1]) });
        });
        return m;
    }, [slot0Q.data, poolAddrs]);

    // Token symbol cache for the per-position display.
    const tokenAddrs = useMemo(() => {
        const s = new Set<string>();
        positions.forEach((p) => {
            s.add(p.token0.toLowerCase());
            s.add(p.token1.toLowerCase());
        });
        return Array.from(s) as Address[];
    }, [positions]);
    const metaQ = useReadContracts({
        contracts: tokenAddrs.flatMap((t) => [
            { address: t, abi: erc20Abi, functionName: "symbol" as const },
            { address: t, abi: erc20Abi, functionName: "decimals" as const },
        ]),
        query: { enabled: tokenAddrs.length > 0 && open },
    });
    const symbolOf = useMemo(() => {
        const m: Record<string, { symbol: string; decimals: number }> = {};
        if (metaQ.data) {
            tokenAddrs.forEach((addr, i) => {
                m[addr.toLowerCase()] = {
                    symbol:
                        (metaQ.data?.[2 * i]?.result as string | undefined) ??
                        (addr.toLowerCase() === USDC_LOWER ? "USDC" : "TKN"),
                    decimals:
                        (metaQ.data?.[2 * i + 1]?.result as number | undefined) ??
                        (addr.toLowerCase() === USDC_LOWER ? USDC_DECIMALS : 18),
                };
            });
        }
        m[USDC_LOWER] = m[USDC_LOWER] ?? { symbol: "USDC", decimals: USDC_DECIMALS };
        return m;
    }, [metaQ.data, tokenAddrs]);

    // Selection state. Initial selection auto-picks every position with
    // non-zero unclaimed fees (the common case). The user can toggle off
    // anything before submitting.
    const [selected, setSelected] = useState<Set<string>>(new Set());
    useEffect(() => {
        if (!open) return;
        const init = new Set<string>();
        positions.forEach((p) => {
            if (p.tokensOwed0 > 0n || p.tokensOwed1 > 0n) {
                init.add(p.tokenId.toString());
            }
        });
        // Only seed when we have data + no manual selection yet to avoid
        // clobbering a user's deliberate empty selection. Stays inside a
        // useEffect because `positions` may arrive AFTER the modal opens
        // (data is fetched on mount of the parent page) and we want the
        // seed to fire when it does, not just on the open transition.
        setSelected((cur) => (cur.size === 0 && init.size > 0 ? init : cur));
    }, [open, positions]);
    // Clear-on-close moved out of useEffect into a render-phase prev-prop
    // check. The seed effect above stays as an effect because it depends
    // on async-arriving `positions`; this teardown only depends on the
    // open transition itself.
    const [prevOpen, setPrevOpen] = useState(open);
    if (open !== prevOpen) {
        setPrevOpen(open);
        if (!open) setSelected(new Set());
    }

    const toggle = (id: string) =>
        setSelected((s) => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const selectAll = () =>
        setSelected(new Set(positions.map((p) => p.tokenId.toString())));
    const clearAll = () => setSelected(new Set());

    // Estimate gas across the batch and convert to USDC. Arc uses USDC as
    // its native gas token (6 decimals), so the raw `gas * gasPrice` value
    // already comes out in USDC units. We sum a per-position estimate then
    // round to a friendly display.
    const [gasEstimateUsdc, setGasEstimateUsdc] = useState<bigint | undefined>(
        undefined,
    );
    useEffect(() => {
        if (!open || !publicClient || !account || selected.size === 0) {
            setGasEstimateUsdc(undefined);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const gasPrice = await publicClient.getGasPrice();
                // Per-position estimate. NPM.collect is bounded; use a
                // measured upper bound of 130k gas (matches Hyperswap's
                // observed cost). Skips the per-id estimateContract round-
                // trip because that requires the position to be approved
                // for collect, which it always is for the owner anyway.
                const perPos = 130_000n;
                const total = BigInt(selected.size) * perPos * gasPrice;
                if (!cancelled) setGasEstimateUsdc(total);
            } catch {
                if (!cancelled) setGasEstimateUsdc(undefined);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, publicClient, account, selected.size]);

    const [submitting, setSubmitting] = useState(false);

    async function onClaim() {
        if (!account || !publicClient || selected.size === 0) return;
        try {
            setSubmitting(true);
            const ids = positions
                .filter((p) => selected.has(p.tokenId.toString()))
                .map((p) => p.tokenId);
            const deadline = Math.floor(Date.now() / 1000) + 600;
            void deadline;
            // collect() per id. Each fires its own tx so the user signs
            // them sequentially in the wallet popup. Batching via
            // multicall would require a separate contract; queued for the
            // ArcLens drop where we wire a generic multicall.
            for (const id of ids) {
                const hash = await writeContractAsync({
                    address: ADDRESSES.v3PositionManager,
                    abi: V3_NPM_ABI,
                    functionName: "collect",
                    args: [
                        {
                            tokenId: id,
                            recipient: account,
                            amount0Max: MAX_UINT128,
                            amount1Max: MAX_UINT128,
                        },
                    ],
                });
                await publicClient.waitForTransactionReceipt({ hash });
            }
            pushToast({
                kind: "info",
                title: "Fees claimed",
                message: `Collected fees on ${ids.length} position${ids.length === 1 ? "" : "s"}.`,
            });
            void arcTestnet;
            onSuccess?.();
        } catch (e: unknown) {
            const o = e as Record<string, unknown> | null;
            const reason =
                o && typeof o === "object"
                    ? ((o.cause as Record<string, unknown> | undefined)?.reason as string | undefined) ??
                      (o.shortMessage as string | undefined) ??
                      (o.message as string | undefined)
                    : undefined;
            pushToast({
                kind: "error",
                title: "Claim failed",
                message: (reason || (e instanceof Error ? e.message : "Failed")).slice(0, 200),
            });
        } finally {
            setSubmitting(false);
        }
    }

    const claimable = positions.filter(
        (p) => p.tokensOwed0 > 0n || p.tokensOwed1 > 0n,
    );

    return (
        <Modal
            open={open}
            onClose={onClose}
            widthClassName="max-w-lg"
            backdropClassName="bg-black/40 backdrop-blur-md"
            className="border-arc-border bg-black/55 backdrop-blur-2xl"
        >
            <div className="flex items-center justify-between border-b border-arc-border px-5 py-4">
                <h3 className="text-base font-semibold">Claim rewards</h3>
                <button type="button"
                    onClick={onClose}
                    className="rounded-full border border-arc-border bg-black/30 p-1.5 text-arc-text-muted hover:text-arc-text"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
            <div className="space-y-3 p-5">
                <div className="flex items-center justify-between">
                    <div className="text-xs text-arc-text-muted">
                        {claimable.length} position{claimable.length === 1 ? "" : "s"} with
                        unclaimed fees
                    </div>
                    <button type="button"
                        onClick={selected.size === positions.length ? clearAll : selectAll}
                        className="rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-1 text-xs font-semibold text-arc-text transition-colors hover:bg-white/5"
                    >
                        {selected.size === positions.length ? "Clear selected positions" : "Select all positions"}
                    </button>
                </div>

                {positions.length === 0 ? (
                    <div className="rounded-xl border border-arc-border bg-white/[0.015] p-6 text-center text-sm text-arc-text-muted">
                        {balanceQ.isLoading
                            ? "Loading your positions…"
                            : "You don't have any V3 positions yet."}
                    </div>
                ) : (
                    <div className="max-h-72 space-y-2 overflow-y-auto">
                        {positions.map((p, i) => {
                            const isSelected = selected.has(p.tokenId.toString());
                            const slot0 =
                                poolAddrs[i]
                                    ? slot0ByPool.get(poolAddrs[i]!.toLowerCase())
                                    : undefined;
                            const inRange =
                                p.liquidity > 0n &&
                                !!slot0 &&
                                slot0.tick >= p.tickLower &&
                                slot0.tick < p.tickUpper;
                            const s0 = symbolOf[p.token0.toLowerCase()] ?? {
                                symbol: "?",
                                decimals: 18,
                            };
                            const s1 = symbolOf[p.token1.toLowerCase()] ?? {
                                symbol: "?",
                                decimals: 18,
                            };
                            return (
                                <button type="button"
                                    key={p.tokenId.toString()}
                                    onClick={() => toggle(p.tokenId.toString())}
                                    className={cn(
                                        "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors",
                                        isSelected
                                            ? "border-arc-success bg-arc-success/5"
                                            : "border-arc-border bg-white/[0.015] hover:bg-white/[0.04]",
                                    )}
                                >
                                    <div className="flex min-w-0 flex-1 items-center gap-3">
                                        <div className="flex -space-x-3">
                                            <TokenIcon symbol={s0.symbol} size={28} />
                                            <TokenIcon symbol={s1.symbol} size={28} />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className="text-xs font-semibold">
                                                    ID:{p.tokenId.toString()}
                                                </span>
                                                <span
                                                    className={cn(
                                                        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                                                        p.liquidity === 0n
                                                            ? "bg-arc-bg-elevated text-arc-text-muted"
                                                            : inRange
                                                              ? "bg-arc-success/15 text-arc-success"
                                                              : "bg-arc-warn/15 text-arc-warn",
                                                    )}
                                                >
                                                    <span
                                                        className={cn(
                                                            "h-1.5 w-1.5 rounded-full",
                                                            p.liquidity === 0n
                                                                ? "bg-arc-text-muted"
                                                                : inRange
                                                                  ? "bg-arc-success"
                                                                  : "bg-arc-warn",
                                                        )}
                                                    />
                                                    {p.liquidity === 0n
                                                        ? "Inactive"
                                                        : inRange
                                                          ? "In range"
                                                          : "Out of range"}
                                                </span>
                                            </div>
                                            <div className="mt-0.5 text-xs text-arc-text-muted">
                                                {s0.symbol} / {s1.symbol}
                                            </div>
                                            <div className="mt-1 text-[11px] text-arc-text-muted">
                                                Unclaimed:
                                                <span className="ml-1 tabular-nums text-arc-text">
                                                    {fmtTok(p.tokensOwed0, s0.decimals)} {s0.symbol}
                                                </span>
                                                <span className="text-arc-text-faint"> / </span>
                                                <span className="tabular-nums text-arc-text">
                                                    {fmtTok(p.tokensOwed1, s1.decimals)} {s1.symbol}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <CheckCircle2
                                        className={cn(
                                            "h-5 w-5 shrink-0",
                                            isSelected
                                                ? "text-arc-success"
                                                : "text-arc-text-faint opacity-50",
                                        )}
                                    />
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Gas estimate in USDC (Arc's gas token). Hidden until a
                    selection exists so the empty state isn't noisy. */}
                {selected.size > 0 && (
                    <div className="flex items-center gap-2 rounded-xl border border-arc-border bg-white/[0.015] p-3 text-xs text-arc-text-muted">
                        <Info className="h-3.5 w-3.5" />
                        <span>
                            Estimated gas:{" "}
                            <span className="font-semibold tabular-nums text-arc-text">
                                {gasEstimateUsdc !== undefined
                                    ? fmtGasUsdc(gasEstimateUsdc)
                                    : "—"}
                            </span>
                        </span>
                    </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                    <button type="button"
                        onClick={onClaim}
                        disabled={selected.size === 0 || submitting}
                        className={cn(
                            "flex-1 rounded-xl py-2.5 text-sm font-semibold transition-colors",
                            selected.size === 0 || submitting
                                ? "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted"
                                : "bg-arc-cta text-white hover:bg-arc-cta-hover",
                        )}
                    >
                        {submitting
                            ? "Claiming…"
                            : selected.size === 0
                              ? "Select positions"
                              : selected.size === 1
                                ? "Claim"
                                : "Claim all"}
                    </button>
                    <button type="button"
                        onClick={onClose}
                        className="rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-2.5 text-sm font-semibold text-arc-text transition-colors hover:bg-white/5"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </Modal>
    );
}

function fmtTok(raw: bigint, decimals: number): string {
    if (raw === 0n) return "0";
    const n = Number(formatUnits(raw, decimals));
    if (n < 0.0001) return "<0.0001";
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// Format an Arc gas total (wei) as a $-prefixed USDC value. Arc accounts
// gas in wei (18 decimals, standard EVM) but pays it out of the user's
// USDC balance via an implicit 1:1 wei -> USDC-smallest-unit mapping at
// debit time. So we format the raw wei with 18 decimals - using USDC's
// 6 decimals would over-count by 1e12.
function fmtGasUsdc(weiTotal: bigint): string {
    const usd = Number(formatUnits(weiTotal, 18));
    if (usd < 0.0001) return "<$0.0001";
    if (usd < 1) return `$${usd.toFixed(4)}`;
    return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
void USDC_DECIMALS;

