"use client";

import {
    AlertTriangle,
    ArrowLeft,
    ExternalLink,
    Receipt,
    RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
import { ADDRESSES } from "@/lib/constants";
import { cn, formatAddress } from "@/lib/utils";

/**
 * Treasury fee history. Owner-gated like the admin hub (escrow.owner()
 * check). The data itself comes from a server API route (/api/admin/fees)
 * because browser-side ETH RPC is blocked by ad-blockers on Arc, so the
 * USDC Transfer scan has to run server-side.
 */

const EXPLORER_TX = "https://testnet.arcscan.app/tx/";

interface FeeItem {
    txHash: string;
    block: number;
    timestamp: number;
    amountUsdc: string;
    from: string;
    reason: string;
    isFee: boolean;
}

interface FeesResponse {
    ok: true;
    treasury: string;
    fromBlock: number;
    toBlock: number;
    totalUsdc: string;
    grossUsdc: string;
    count: number;
    grossCount: number;
    truncated: boolean;
    note: string;
    items: FeeItem[];
}

export default function FeesPage() {
    const { address: account } = useAccount();
    const escrow = ADDRESSES.twitterEscrow;

    const ownerQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "owner",
        query: { enabled: !!escrow },
    });
    const owner = ownerQ.data as Address | undefined;
    const isOwner =
        !!account && !!owner && owner.toLowerCase() === account.toLowerCase();

    if (!account) {
        return (
            <UnauthorizedShell
                title="Connect your wallet"
                body="The fee history is gated on the escrow contract's owner. Connect with the owner wallet to continue."
            />
        );
    }

    if (!isOwner) {
        return (
            <UnauthorizedShell
                title="Not the admin"
                body={
                    <span>
                        This wallet is <code>{formatAddress(account)}</code>. The owner is{" "}
                        <code>{owner ? formatAddress(owner) : "(loading)"}</code>. Switch
                        wallets to view the treasury fee history.
                    </span>
                }
            />
        );
    }

    return <FeesBody />;
}

// Flat launch fees (from ArcadeHook constants) -- derived from subgraph counts.
const CREATION_FEE_USD = 3;
const MIGRATION_FEE_USD = 2500;

interface FeeBreakdown {
    creationUsd: number;
    graduationUsd: number;
    treasuryTradingUsd: number;
    creatorTradingUsd: number;
    antiSnipeUsd: number;
    clankerHarvests: number;
    // 1.7.0 categories
    curveUsd: number; // 1% curve fee (total; PUMP 50/50 platform/creator)
    v2ProtocolUsd: number; // V2 graduated-pair 0.15% protocol
    v2CreatorUsd: number; // V2 graduated-pair 0.05% creator
    v3LpUsd: number; // V3 locker LP fees collected (total; 80/20 creator/treasury)
    compounderUsd: number; // auto-compound protocol fee (net)
    compounderCount: number;
    bridgeUsd: number; // CCTP bridge-and-buy fee (0.05%)
    referralUsd: number; // referral surcharge collected
}

/**
 * All-time fee breakdown by category from the Goldsky subgraph. V4 trading /
 * anti-sniper come EXACT from FeeStats; creation + graduation fees are derived
 * from Global counts x the flat on-chain constants (both are fixed amounts, so
 * count x rate is exact). Legacy V2/V3-locker/compounder/referral/bridge fees
 * are not yet indexed -- listed as a caveat. Renders nothing pre-redeploy.
 */
function FeeCategoriesCard() {
    const [bd, setBd] = useState<FeeBreakdown | null>(null);
    useEffect(() => {
        const url = process.env.NEXT_PUBLIC_GOLDSKY_URL;
        if (!url) return;
        let cancelled = false;
        const q = `{ feeStats(id: "v4") { creatorFeesUsdc treasuryFeesUsdc antiSnipeUsdc clankerHarvests curveFeesUsdc v2ProtocolUsdc v2CreatorUsdc v3LpFeesUsdc compounderProtocolUsdc compounderCount bridgeFeesUsdc referralFeesUsdc } global(id: "global") { tokenCount graduatedCount } }`;
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
                if (cancelled || !j?.data) return;
                const f = j.data.feeStats ?? {};
                const g = j.data.global ?? {};
                setBd({
                    creationUsd: (Number(g.tokenCount) || 0) * CREATION_FEE_USD,
                    graduationUsd: (Number(g.graduatedCount) || 0) * MIGRATION_FEE_USD,
                    treasuryTradingUsd: Number(f.treasuryFeesUsdc) || 0,
                    creatorTradingUsd: Number(f.creatorFeesUsdc) || 0,
                    antiSnipeUsd: Number(f.antiSnipeUsdc) || 0,
                    clankerHarvests: Number(f.clankerHarvests) || 0,
                    curveUsd: Number(f.curveFeesUsdc) || 0,
                    v2ProtocolUsd: Number(f.v2ProtocolUsdc) || 0,
                    v2CreatorUsd: Number(f.v2CreatorUsdc) || 0,
                    v3LpUsd: Number(f.v3LpFeesUsdc) || 0,
                    compounderUsd: Number(f.compounderProtocolUsdc) || 0,
                    compounderCount: Number(f.compounderCount) || 0,
                    bridgeUsd: Number(f.bridgeFeesUsdc) || 0,
                    referralUsd: Number(f.referralFeesUsdc) || 0,
                });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);
    if (!bd) return null;
    // Protocol (treasury) share of each category. Curve is PUMP 50/50; V3 locker
    // LP fees split 80/20 creator/treasury; V2 protocol + compounder fee are
    // already the treasury-side amounts.
    const curvePlatformUsd = bd.curveUsd * 0.5;
    const v3LpTreasuryUsd = bd.v3LpUsd * 0.2;
    const protocolTotal =
        bd.creationUsd +
        bd.graduationUsd +
        bd.treasuryTradingUsd +
        bd.v2ProtocolUsd +
        v3LpTreasuryUsd +
        bd.compounderUsd +
        curvePlatformUsd +
        bd.bridgeUsd +
        bd.referralUsd;
    const fmt = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    return (
        <div className="arc-card mb-6 p-6">
            <div className="text-xs uppercase tracking-wider text-arc-text-muted">
                Fees by category · all-time (indexer)
            </div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">
                {fmt(protocolTotal)}{" "}
                <span className="text-sm font-normal text-arc-text-faint">protocol revenue → treasury</span>
            </div>
            <div className="mt-4 space-y-2 text-sm">
                <CatRow label="Launch creation fees" sub="3 USDC × launches → treasury" value={fmt(bd.creationUsd)} />
                <CatRow label="Graduation fees" sub="2,500 USDC × graduations → treasury" value={fmt(bd.graduationUsd)} />
                <CatRow label="Curve trading fee — platform (50%)" sub="1% pre-graduation curve fee · platform half" value={fmt(curvePlatformUsd)} />
                <CatRow label="V2 swap fee — protocol (0.15%)" sub="Graduated-pair input fee → treasury" value={fmt(bd.v2ProtocolUsd)} />
                <CatRow label="V3 LP fees — treasury (20%)" sub="Locker-collected LP fees · treasury share" value={fmt(v3LpTreasuryUsd)} />
                <CatRow label="Auto-compound fee" sub={`≤10% of compounded LP fees → treasury · ${bd.compounderCount} compound${bd.compounderCount === 1 ? "" : "s"}`} value={fmt(bd.compounderUsd)} />
                <CatRow label="V4 trading fee — protocol (20%)" sub="V4 post-graduation → treasury" value={fmt(bd.treasuryTradingUsd)} />
                <CatRow label="CCTP bridge fee (0.05%)" sub="Bridge-and-buy → treasury" value={fmt(bd.bridgeUsd)} />
                <CatRow label="Referral surcharge" sub="Collected on referred swaps (default off)" value={fmt(bd.referralUsd)} />
                <div className="my-1 border-t border-arc-border/60" />
                <div className="text-[11px] uppercase tracking-wider text-arc-text-faint">Goes to creators / LPs (not treasury)</div>
                <CatRow label="Curve trading fee — creator (50%)" sub="1% curve fee · creator half" value={fmt(bd.curveUsd * 0.5)} muted />
                <CatRow label="V2 swap fee — creator (0.05%)" sub="Graduated-pair → launch creators" value={fmt(bd.v2CreatorUsd)} muted />
                <CatRow label="V3 LP fees — creators (80%)" sub="Locker-collected LP fees · creator share" value={fmt(bd.v3LpUsd * 0.8)} muted />
                <CatRow label="V4 trading fee — creators (80%)" sub="V4 post-graduation → launch creators" value={fmt(bd.creatorTradingUsd)} muted />
                <CatRow label="Anti-sniper auction" sub="→ launch creators" value={fmt(bd.antiSnipeUsd)} muted />
                <CatRow label="CLANKER fee harvests" sub={`${bd.clankerHarvests} harvest event${bd.clankerHarvests === 1 ? "" : "s"} · USD folded into V4 trading fees`} value="—" muted />
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-arc-text-faint">
                Every protocol fee source is now categorised from the indexer. Token-denominated legs
                (V2 sells, CLANKER token-side, referral in-token) are valued at the token&apos;s last
                traded price; CLANKER token-side creator fees with no reliable price are not counted.
            </p>
        </div>
    );
}

function CatRow({ label, sub, value, muted }: { label: string; sub: string; value: string; muted?: boolean }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <div className={cn("font-medium", muted && "text-arc-text-muted")}>{label}</div>
                <div className="text-[11px] text-arc-text-faint">{sub}</div>
            </div>
            <div className="shrink-0 tabular-nums font-semibold">{value}</div>
        </div>
    );
}

function FeesBody() {
    const [data, setData] = useState<FeesResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/admin/fees", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json?.ok) {
                throw new Error(json?.error ?? `Request failed (${res.status})`);
            }
            setData(json as FeesResponse);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to load fee history");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
            <Link
                href="/admin"
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> Admin
            </Link>

            <div className="mb-8 flex items-start gap-3">
                <Receipt className="mt-1 h-6 w-6 text-arc-cta-hover" />
                <div className="flex-1">
                    <div className="flex items-center justify-between gap-3">
                        <h1 className="text-3xl font-semibold sm:text-4xl">Treasury fees</h1>
                        <button
                            type="button"
                            onClick={() => void load()}
                            disabled={loading}
                            className={cn(
                                "inline-flex items-center gap-2 rounded-xl border border-arc-border bg-white/[0.015] px-3 py-2 text-xs text-arc-text-muted transition-colors hover:text-arc-text",
                                loading && "opacity-60",
                            )}
                        >
                            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                            Refresh
                        </button>
                    </div>
                    <p className="mt-1 text-sm text-arc-text-muted">
                        Protocol fees received by the Arcade treasury, categorized by source.
                    </p>
                </div>
            </div>

            {/* Header / totals card */}
            <div className="arc-card mb-6 p-6">
                {loading && !data ? (
                    <div className="space-y-3">
                        <div className="h-3 w-40 animate-pulse rounded bg-white/5" />
                        <div className="h-10 w-56 animate-pulse rounded bg-white/5" />
                        <div className="h-3 w-72 animate-pulse rounded bg-white/5" />
                    </div>
                ) : data ? (
                    <>
                        <div className="text-xs uppercase tracking-wider text-arc-text-muted">
                            Recognized protocol fees (scanned window)
                        </div>
                        <div className="mt-2 text-4xl font-semibold tabular-nums sm:text-5xl">
                            ${formatTwo(data.totalUsdc)}
                        </div>
                        <div className="mt-3 text-xs text-arc-text-faint">
                            {data.count.toLocaleString("en-US")} fee transfer
                            {data.count === 1 ? "" : "s"} · blocks{" "}
                            {data.fromBlock.toLocaleString("en-US")} to{" "}
                            {data.toBlock.toLocaleString("en-US")}
                        </div>
                        <div className="mt-2 text-xs text-arc-text-faint">
                            Total inbound USDC (incl. trades / direct):{" "}
                            <span className="tabular-nums text-arc-text-muted">
                                ${formatTwo(data.grossUsdc)}
                            </span>{" "}
                            across {data.grossCount.toLocaleString("en-US")} transfer
                            {data.grossCount === 1 ? "" : "s"}.
                        </div>
                        <div className="mt-2 text-xs text-arc-text-faint">{data.note}</div>
                        {data.truncated && (
                            <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-arc-warn/10 px-3 py-1.5 text-xs text-arc-warn">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                At least one scan window failed; totals may be partial.
                            </div>
                        )}
                    </>
                ) : null}
            </div>

            {/* All-time fee breakdown by category, from the subgraph. */}
            <FeeCategoriesCard />

            {/* Error state */}
            {error && (
                <div className="arc-card flex items-center gap-3 p-6 text-sm text-arc-danger">
                    <AlertTriangle className="h-5 w-5 shrink-0" />
                    <div>
                        <div className="font-semibold">Could not load fee history</div>
                        <div className="mt-0.5 text-arc-text-muted">{error}</div>
                    </div>
                </div>
            )}

            {/* List */}
            {!error && (
                <div className="arc-card overflow-hidden p-0">
                    {/* header row */}
                    <div className="hidden grid-cols-[1.2fr_0.8fr_1.6fr_1fr_0.5fr] gap-3 border-b border-arc-border px-5 py-3 text-[10px] uppercase tracking-wider text-arc-text-muted sm:grid">
                        <span>When</span>
                        <span className="text-right">Amount</span>
                        <span>Reason</span>
                        <span>From</span>
                        <span className="text-right">Tx</span>
                    </div>

                    {loading && !data ? (
                        <div className="divide-y divide-arc-border">
                            {Array.from({ length: 5 }).map((_, i) => (
                                <div key={i} className="px-5 py-4">
                                    <div className="h-4 w-full animate-pulse rounded bg-white/5" />
                                </div>
                            ))}
                        </div>
                    ) : data && data.items.length === 0 ? (
                        <div className="px-5 py-12 text-center text-sm text-arc-text-muted">
                            No fees received in the scanned window yet.
                        </div>
                    ) : data ? (
                        <div className="divide-y divide-arc-border">
                            {data.items.map((item) => (
                                <FeeRow key={`${item.txHash}-${item.block}`} item={item} />
                            ))}
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function FeeRow({ item }: { item: FeeItem }) {
    return (
        <div className="grid grid-cols-1 gap-1 px-5 py-4 text-sm transition-colors hover:bg-white/[0.02] sm:grid-cols-[1.2fr_0.8fr_1.6fr_1fr_0.5fr] sm:items-center sm:gap-3">
            <div className="text-arc-text">
                <span className="sm:hidden text-[10px] uppercase tracking-wider text-arc-text-muted">
                    When:{" "}
                </span>
                {formatWhen(item.timestamp)}
            </div>
            <div
                className={cn(
                    "tabular-nums font-semibold sm:text-right",
                    item.isFee ? "text-arc-success" : "text-arc-text-faint",
                )}
            >
                <span className="sm:hidden text-[10px] uppercase tracking-wider text-arc-text-muted">
                    Amount:{" "}
                </span>
                +${formatTwo(item.amountUsdc)}
                {!item.isFee && (
                    <span className="ml-1 text-[10px] uppercase tracking-wider text-arc-text-faint">
                        (not a fee)
                    </span>
                )}
            </div>
            <div className="text-xs text-arc-text-muted">
                <span className="sm:hidden text-[10px] uppercase tracking-wider">
                    Reason:{" "}
                </span>
                {item.reason}
            </div>
            <div className="font-mono text-xs text-arc-text-muted">
                <span className="sm:hidden text-[10px] uppercase tracking-wider">
                    From:{" "}
                </span>
                {formatAddress(item.from)}
            </div>
            <div className="sm:text-right">
                {item.txHash ? (
                    <a
                        href={`${EXPLORER_TX}${item.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-arc-cta-hover transition-colors hover:text-arc-text"
                    >
                        View <ExternalLink className="h-3 w-3" />
                    </a>
                ) : (
                    <span className="text-xs text-arc-text-faint">n/a</span>
                )}
            </div>
        </div>
    );
}

/** Reduce a "12.500000" 6-dec human string to 2 fractional digits, grouped.
 *  Fee audit 2026-07-02 LOW-4: rounds to the nearest cent instead of
 *  truncating, so 12.999999 reads $13.00 rather than $12.99. Works in
 *  integer micros (BigInt) to avoid float error. */
function formatTwo(human: string): string {
    const neg = human.startsWith("-");
    const clean = neg ? human.slice(1) : human;
    const [whole = "0", frac = ""] = clean.split(".");
    let micros: bigint;
    try {
        micros = BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
    } catch {
        return `${neg ? "-" : ""}${human}`;
    }
    const cents = (micros + 5_000n) / 10_000n; // round half up to cents
    const grouped = (cents / 100n).toLocaleString("en-US");
    const centPart = (cents % 100n).toString().padStart(2, "0");
    return `${neg ? "-" : ""}${grouped}.${centPart}`;
}

function formatWhen(ts: number): string {
    if (!ts) return "unknown";
    return new Date(ts * 1000).toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function UnauthorizedShell({ title, body }: { title: string; body: React.ReactNode }) {
    return (
        <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
            <Link
                href="/admin"
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> Admin
            </Link>
            <div className="arc-card p-6">
                <div className="flex items-center gap-2 text-arc-warn">
                    <Receipt className="h-5 w-5" />
                    <h1 className="text-lg font-semibold">{title}</h1>
                </div>
                <p className="mt-3 text-sm text-arc-text-muted">{body}</p>
            </div>
        </div>
    );
}
