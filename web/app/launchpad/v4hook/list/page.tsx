"use client";

import { ArrowLeft, Lock, Plus, Rocket, Search, ShieldCheck, ShieldOff } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { ARCADE_HOOK_STATUS } from "@/lib/abis/arcadeHook";
import { V4_HOOK_ENABLED } from "@/lib/constants";
import { useArcadeHookTokens, type ArcadeHookTokenInfo } from "@/lib/hooks/useArcadeHookTokens";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

type Filter = "all" | "curving" | "graduated" | "snipe-active";

const GRAD_USDC = 20_000n * 10n ** 6n;
const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

const MODE_LABEL: Record<number, string> = {
    0: "PUMP",
    1: "CLANKER",
    2: "CLANKER V3",
};

export default function ArcadeHookListPage() {
    if (!V4_HOOK_ENABLED) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="rounded-2xl border border-arc-border bg-arc-surface p-8 text-center">
                    <Lock className="mx-auto h-8 w-8 text-arc-text-muted" />
                    <h1 className="mt-4 text-xl font-semibold">ArcadeHook not configured</h1>
                    <p className="mt-2 text-sm text-arc-text-muted">
                        Set the V4 hook addresses in env to access this page.
                    </p>
                    <Link
                        href="/launchpad"
                        className="mt-6 inline-block rounded-lg border border-arc-border bg-arc-surface px-4 py-2 text-sm hover:border-arc-primary/40"
                    >
                        Back to launchpad
                    </Link>
                </div>
            </div>
        );
    }
    return <Inner />;
}

function Inner() {
    const { tokens, isLoading } = useArcadeHookTokens();
    const [filter, setFilter] = useState<Filter>("all");
    const [q, setQ] = useState("");

    const nowSec = Math.floor(Date.now() / 1000);

    const filtered = useMemo(() => {
        let list = [...tokens];
        if (filter === "curving") {
            list = list.filter((t) => t.status === ARCADE_HOOK_STATUS.CURVING);
        } else if (filter === "graduated") {
            list = list.filter((t) => t.status === ARCADE_HOOK_STATUS.GRADUATED);
        } else if (filter === "snipe-active") {
            list = list.filter(
                (t) =>
                    t.snipeStartBps > 0 &&
                    t.snipeDecaySeconds > 0 &&
                    Number(t.snipeLaunchedAt) + t.snipeDecaySeconds > nowSec,
            );
        }
        // Most-recent first via reverse-registry order.
        list = list.reverse();

        const term = q.trim().toLowerCase();
        if (term) {
            list = list.filter(
                (t) =>
                    (t.name ?? "").toLowerCase().includes(term) ||
                    (t.symbol ?? "").toLowerCase().includes(term) ||
                    t.address.toLowerCase().includes(term),
            );
        }
        return list;
    }, [tokens, filter, q, nowSec]);

    return (
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
            <div className="mb-6 flex items-center gap-3">
                <Link
                    href="/launchpad"
                    className="rounded-lg border border-arc-border bg-arc-surface p-2 hover:border-arc-cta-hover/40"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Link>
                <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Rocket className="h-5 w-5 text-arc-cta-hover" />
                        <h1 className="text-2xl font-semibold sm:text-3xl">ArcadeHook launches</h1>
                        <span className="rounded-md border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-cta-hover">
                            v4 hook
                        </span>
                    </div>
                    <p className="mt-1 text-sm text-arc-text-muted">
                        Tokens launched on the unified V4 hook stack. USDC-quoted, atomic
                        graduation, locked LP.
                    </p>
                </div>
                <Link
                    href="/launchpad/v4hook/create"
                    className="flex items-center gap-2 rounded-xl bg-arc-cta px-3 py-2 text-sm font-medium text-white hover:bg-arc-cta-hover sm:px-4"
                >
                    <Plus className="h-4 w-4" />
                    <span className="hidden sm:inline">New launch</span>
                </Link>
            </div>

            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1">
                    {(["all", "curving", "graduated", "snipe-active"] as Filter[]).map((f) => (
                        <button type="button"
                            key={f}
                            onClick={() => setFilter(f)}
                            className={cn(
                                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                                filter === f
                                    ? "bg-arc-cta text-white"
                                    : "text-arc-text-muted hover:bg-arc-surface hover:text-arc-text",
                            )}
                        >
                            {f === "all"
                                ? "All"
                                : f === "curving"
                                  ? "Curving"
                                  : f === "graduated"
                                    ? "Graduated"
                                    : "Snipe active"}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 sm:w-72">
                    <Search className="h-4 w-4 text-arc-text-faint" />
                    <input
                        aria-label="Search launches"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search name, symbol, address"
                        className="arc-input w-full bg-transparent text-sm"
                    />
                </div>
            </div>

            {isLoading && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {[...Array(6)].map((_, i) => (
                        <SkeletonCard key={i} className="h-44" />
                    ))}
                </div>
            )}
            {!isLoading && filtered.length === 0 && (
                <div className="arc-card p-12 text-center text-arc-text-muted">
                    {tokens.length === 0 ? (
                        <>
                            No ArcadeHook launches yet.{" "}
                            <Link
                                href="/launchpad/v4hook/create"
                                className="text-arc-cta-hover hover:underline"
                            >
                                Be the first →
                            </Link>
                        </>
                    ) : (
                        "No tokens match the current filter."
                    )}
                </div>
            )}
            {!isLoading && filtered.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((t) => (
                        <ArcadeHookListCard key={t.address} token={t} nowSec={nowSec} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ArcadeHookListCard({ token, nowSec }: { token: ArcadeHookTokenInfo; nowSec: number }) {
    const { image } = useTokenImage(token.address);

    const raisedPct = useMemo(() => {
        if (GRAD_USDC === 0n) return 0;
        const bps = (token.realUsdcReserve * 10_000n) / GRAD_USDC;
        return Math.min(100, Number(bps) / 100);
    }, [token.realUsdcReserve]);

    const tokensSoldPct = useMemo(() => {
        const bps = (token.tokensSold * 10_000n) / CURVE_SUPPLY;
        return Math.min(100, Number(bps) / 100);
    }, [token.tokensSold]);

    const isGraduated = token.status === ARCADE_HOOK_STATUS.GRADUATED;
    const snipeRemaining =
        token.snipeStartBps > 0 && token.snipeDecaySeconds > 0
            ? Math.max(0, Number(token.snipeLaunchedAt) + token.snipeDecaySeconds - nowSec)
            : 0;
    const snipeActive = snipeRemaining > 0;

    return (
        <Link
            href={`/launchpad/v4hook/${token.address}`}
            className="arc-card group flex flex-col gap-3 p-4 transition-colors hover:border-arc-cta-hover/40"
        >
            <div className="flex items-start gap-3">
                <TokenIcon symbol={token.symbol ?? "?"} image={image} size={48} />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold">
                        {token.name ?? "Unnamed"}{" "}
                        <span className="text-arc-text-muted">{token.symbol ?? ""}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-arc-text-faint">
                        {token.address.slice(0, 8)}...{token.address.slice(-6)}
                    </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="rounded-md border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-arc-cta-hover">
                        {MODE_LABEL[token.mode] ?? "?"}
                    </span>
                    <span
                        className={cn(
                            "rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider",
                            isGraduated
                                ? "border-arc-success/40 bg-arc-success/10 text-arc-success"
                                : "border-arc-cta-hover/40 bg-arc-cta-hover/10 text-arc-cta-hover",
                        )}
                    >
                        {isGraduated ? "Graduated" : "Curving"}
                    </span>
                </div>
            </div>

            <div>
                <div className="mb-1 flex justify-between text-[10px] text-arc-text-faint">
                    <span>{raisedPct.toFixed(1)}% to graduation</span>
                    <span>
                        {(Number(token.realUsdcReserve) / 1e6).toLocaleString(undefined, {
                            maximumFractionDigits: 0,
                        })}{" "}
                        / 20k USDC
                    </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-arc-bg-elevated">
                    <div
                        className={cn(
                            "absolute left-0 top-0 h-full transition-all",
                            isGraduated
                                ? "bg-arc-success"
                                : "bg-gradient-to-r from-arc-cta to-arc-cta-hover",
                        )}
                        style={{ width: `${isGraduated ? 100 : raisedPct}%` }}
                    />
                </div>
            </div>

            <div className="flex items-center justify-between text-[10px] text-arc-text-faint">
                <span>{tokensSoldPct.toFixed(1)}% of 800M sold</span>
                {snipeActive ? (
                    <span className="inline-flex items-center gap-1 text-arc-warn">
                        <ShieldCheck className="h-3 w-3" />
                        Snipe {formatRemaining(snipeRemaining)} left
                    </span>
                ) : token.snipeStartBps > 0 ? (
                    <span className="inline-flex items-center gap-1">
                        <ShieldOff className="h-3 w-3" />
                        Snipe expired
                    </span>
                ) : (
                    <span>No snipe tax</span>
                )}
            </div>
        </Link>
    );
}

function formatRemaining(seconds: number): string {
    if (seconds <= 0) return "0s";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
}
