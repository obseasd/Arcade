"use client";

import { CheckCircle2, Info } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import { Address, erc20Abi, formatUnits, zeroAddress } from "viem";
import {
    useAccount,
    usePublicClient,
    useReadContract,
    useReadContracts,
    useWriteContract,
} from "wagmi";

import { runSequential } from "@/lib/routing/runSequential";
import { V3_FACTORY_ABI, V3_NPM_ABI, V3_POOL_ABI } from "@/lib/abis/v3-npm";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { Modal } from "@/components/ui/Modal";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { pushToast } from "@/lib/toast";
import { addActivity } from "@/lib/activityFeed";
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
    // RACE-006: track whether the user has touched the selection. The
    // seed effect uses `cur.size === 0` as a proxy for "never seeded",
    // but that can't distinguish "still loading" from "user explicitly
    // cleared". With this ref we only seed when the user hasn't
    // interacted yet, and the toggle/selectAll/clearAll handlers flip it
    // permanently.
    const userTouchedRef = useRef(false);
    useEffect(() => {
        if (!open) return;
        if (userTouchedRef.current) return;
        const init = new Set<string>();
        positions.forEach((p) => {
            if (p.tokensOwed0 > 0n || p.tokensOwed1 > 0n) {
                init.add(p.tokenId.toString());
            }
        });
        if (init.size > 0) setSelected(init);
    }, [open, positions]);
    // Clear-on-close + reset the interaction flag so the next open
    // re-seeds fresh. Done as a render-phase prev-prop check (rather
    // than a teardown effect) so the first paint after open re-mirrors
    // the seeded state without an extra render cycle.
    const [prevOpen, setPrevOpen] = useState(open);
    if (open !== prevOpen) {
        setPrevOpen(open);
        if (!open) {
            setSelected(new Set());
            userTouchedRef.current = false;
        }
    }

    const toggle = (id: string) => {
        userTouchedRef.current = true;
        setSelected((s) => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
    const selectAll = () => {
        userTouchedRef.current = true;
        setSelected(new Set(positions.map((p) => p.tokenId.toString())));
    };
    const clearAll = () => {
        userTouchedRef.current = true;
        setSelected(new Set());
    };

    // Estimate gas across the batch and convert to USDC. Arc uses USDC as
    // its native gas token (6 decimals), so the raw `gas * gasPrice` value
    // already comes out in USDC units. We sum a per-position estimate then
    // round to a friendly display.
    // 2026-06-15 audit LOW fix: split the effect so gasPrice is fetched
    // ONCE per modal open, not per checkbox toggle. Previously every
    // selected.size mutation triggered a fresh getGasPrice() RPC even
    // though gas price is per-block, not per-click. selected.size now
    // multiplies the cached value in pure render.
    const [gasPriceWei, setGasPriceWei] = useState<bigint | undefined>(undefined);
    useEffect(() => {
        if (!open || !publicClient || !account) {
            setGasPriceWei(undefined);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const gasPrice = await publicClient.getGasPrice();
                if (!cancelled) setGasPriceWei(gasPrice);
            } catch {
                if (!cancelled) setGasPriceWei(undefined);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, publicClient, account]);
    // Per-position estimate. NPM.collect is bounded; use a measured
    // upper bound of 130k gas (matches Hyperswap's observed cost).
    const gasEstimateUsdc: bigint | undefined = useMemo(() => {
        if (!gasPriceWei || selected.size === 0) return undefined;
        const perPos = 130_000n;
        return BigInt(selected.size) * perPos * gasPriceWei;
    }, [gasPriceWei, selected.size]);

    const [submitting, setSubmitting] = useState(false);

    async function onClaim() {
        if (!account || !publicClient || selected.size === 0) return;
        try {
            setSubmitting(true);
            const ids = positions
                .filter((p) => selected.has(p.tokenId.toString()))
                .map((p) => p.tokenId);
            // Arc's callFrom precompile is dead, so the old "collect every
            // selected position in one Multicall3From signature" batch
            // reverts on-chain. Run one NPM.collect tx per selected
            // position from the user's wallet (msg.sender is the user, who
            // owns each NFT). A single position is just the N=1 case.
            await runSequential(
                ids.map((id) => ({
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
                })),
                { writeContractAsync, publicClient },
            );
            // Per-position breakdown: one toast + one activity entry per
            // position so the user sees exactly what they pocketed. The
            // tokensOwed* readings are pre-claim snapshots; on-chain
            // semantics guarantee these are AT LEAST what's transferred
            // (collect() sweeps everything the position is owed at the
            // moment the tx lands, which can be slightly MORE than the
            // last positionsQ snapshot if fees accrued in the intervening
            // block). The toast is intentionally a snapshot lower bound;
            // the on-chain transfer is authoritative. REACT-002 logged
            // this trade-off — adding a fresh refetch after the receipt
            // would be more accurate but adds two RPC round trips per
            // position for sub-1% precision gain.
            const claimedPositions = positions.filter((p) =>
                selected.has(p.tokenId.toString()),
            );
            for (const p of claimedPositions) {
                const t0Meta = symbolOf[p.token0.toLowerCase()] ?? { symbol: "TKN", decimals: 18 };
                const t1Meta = symbolOf[p.token1.toLowerCase()] ?? { symbol: "TKN", decimals: 18 };
                const a0 = formatUnits(p.tokensOwed0, t0Meta.decimals);
                const a1 = formatUnits(p.tokensOwed1, t1Meta.decimals);
                const parts: string[] = [];
                if (p.tokensOwed0 > 0n) parts.push(`${trimFee(a0)} ${t0Meta.symbol}`);
                if (p.tokensOwed1 > 0n) parts.push(`${trimFee(a1)} ${t1Meta.symbol}`);
                const summary = parts.join(" + ") || "0 fees";
                pushToast({
                    kind: "claim-fees",
                    positionLabel: `#${p.tokenId.toString()}`,
                    token0: { address: p.token0, symbol: t0Meta.symbol },
                    token1: { address: p.token1, symbol: t1Meta.symbol },
                    amount0Formatted: p.tokensOwed0 > 0n ? trimFee(a0) : null,
                    amount1Formatted: p.tokensOwed1 > 0n ? trimFee(a1) : null,
                    positionHref: "/positions",
                });
                addActivity({
                    type: "claim-fees",
                    account,
                    token: p.token0.toLowerCase() === USDC_LOWER ? p.token1 : p.token0,
                    label: `Claimed fees on #${p.tokenId.toString()}`,
                    value: summary,
                });
            }
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
            backdropClassName="backdrop:bg-black/40 backdrop:backdrop-blur-md"
            className="border-arc-border bg-black/55 backdrop-blur-2xl"
        >
            <div className="flex items-center justify-between border-b border-arc-border px-5 py-4">
                <h3 className="text-base font-semibold">Claim rewards</h3>
                <button type="button"
                    onClick={onClose}
                    className="rounded-full border border-arc-border bg-black/30 p-1.5 text-arc-text-muted hover:text-arc-text"
                >
                    <CrossIcon size={16} />
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
                                    role="checkbox"
                                    aria-checked={isSelected}
                                    aria-label={`Toggle position ${p.tokenId.toString()} (${s0.symbol} / ${s1.symbol}) for claim`}
                                    className={cn(
                                        "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors",
                                        isSelected
                                            ? "border-arc-cta-hover bg-arc-cta-hover/10"
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
                                                ? "text-arc-cta-hover"
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

                <div className="pt-1">
                    <button type="button"
                        onClick={onClaim}
                        disabled={selected.size === 0 || submitting}
                        className={cn(
                            "inline-flex w-full items-center justify-center gap-1.5 rounded-xl py-3 text-sm font-semibold transition-colors",
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

/** Trim a formatUnits() string to at most 4 significant decimals, drop
 *  trailing zeros, and add a sub-cent floor so the per-position toast
 *  doesn't show "0.0000003 USDC" but stays informative ("<0.0001 USDC"). */
function trimFee(raw: string): string {
    const n = Number(raw);
    if (!isFinite(n) || n === 0) return "0";
    if (n < 0.0001) return "<0.0001";
    if (n < 1) return n.toFixed(4).replace(/\.?0+$/, "");
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

