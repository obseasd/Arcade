"use client";

import { ArrowLeft, Plus, Search, Lock, Clock, ShieldCheck, ShieldOff } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useV4LaunchpadTokens, V4LaunchpadTokenInfo } from "@/lib/hooks/useV4LaunchpadTokens";
import { V4_ENABLED } from "@/lib/constants";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { cn, formatAddress } from "@/lib/utils";

type Filter = "all" | "live" | "pending" | "decayed";

export default function V4LaunchpadList() {
    if (!V4_ENABLED) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="rounded-2xl border border-arc-border bg-arc-surface p-8 text-center">
                    <Lock className="mx-auto h-8 w-8 text-arc-text-muted" />
                    <h1 className="mt-4 text-xl font-semibold">V4 launches not enabled</h1>
                    <p className="mt-2 text-sm text-arc-text-muted">
                        Set <code>NEXT_PUBLIC_V4_ENABLED=1</code> in env to access this page.
                    </p>
                </div>
            </div>
        );
    }
    return <V4ListInner />;
}

function V4ListInner() {
    const { tokens, isLoading } = useV4LaunchpadTokens();
    const [filter, setFilter] = useState<Filter>("all");
    const [q, setQ] = useState("");

    const nowSec = BigInt(Math.floor(Date.now() / 1000));

    const filtered = useMemo(() => {
        let list = [...tokens];
        if (filter === "live") {
            list = list.filter((t) => t.poolInitialized);
        } else if (filter === "pending") {
            list = list.filter((t) => !t.poolInitialized);
        } else if (filter === "decayed") {
            list = list.filter(
                (t) =>
                    t.snipeDecaySeconds > 0 &&
                    nowSec >= t.launchedAt + BigInt(t.snipeDecaySeconds),
            );
        }
        // Default sort: most recently launched first.
        list = list.sort((a, b) => Number(b.launchedAt - a.launchedAt));

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
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
            <div className="mb-6 flex items-center gap-3">
                <Link
                    href="/launchpad"
                    className="rounded-lg border border-arc-border bg-arc-surface p-2 hover:border-arc-primary/40"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Link>
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <h1 className="text-3xl font-semibold">V4 Launches</h1>
                        <span className="rounded-md border border-arc-primary/40 bg-arc-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-primary">
                            beta
                        </span>
                    </div>
                    <p className="mt-1 text-sm text-arc-text-muted">
                        Tokens launched on the V4 launchpad with the anti-sniper hook.
                    </p>
                </div>
                <Link
                    href="/launchpad/v4"
                    className="flex items-center gap-2 rounded-xl bg-arc-primary px-4 py-2 text-sm font-medium text-white hover:bg-arc-primary/90"
                >
                    <Plus className="h-4 w-4" /> New V4 launch
                </Link>
            </div>

            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1">
                    {(["all", "live", "pending", "decayed"] as Filter[]).map((f) => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={cn(
                                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                                filter === f
                                    ? "bg-arc-primary text-white"
                                    : "text-arc-text-muted hover:bg-arc-surface hover:text-arc-text",
                            )}
                        >
                            {f === "all"
                                ? "All"
                                : f === "live"
                                  ? "Pool live"
                                  : f === "pending"
                                    ? "Pool pending"
                                    : "Snipe decayed"}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 sm:w-72">
                    <Search className="h-4 w-4 text-arc-text-faint" />
                    <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search name, symbol, address"
                        className="arc-input text-sm"
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
                    No V4 launches yet.{" "}
                    <Link href="/launchpad/v4" className="text-arc-primary hover:underline">
                        Create the first one →
                    </Link>
                </div>
            )}
            {!isLoading && filtered.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((t) => (
                        <V4TokenCard key={t.address} token={t} nowSec={nowSec} />
                    ))}
                </div>
            )}
        </div>
    );
}

function V4TokenCard({
    token,
    nowSec,
}: {
    token: V4LaunchpadTokenInfo;
    nowSec: bigint;
}) {
    const decayed =
        token.snipeDecaySeconds > 0 &&
        nowSec >= token.launchedAt + BigInt(token.snipeDecaySeconds);
    const remaining =
        token.snipeDecaySeconds > 0
            ? Number(
                  token.launchedAt + BigInt(token.snipeDecaySeconds) > nowSec
                      ? token.launchedAt + BigInt(token.snipeDecaySeconds) - nowSec
                      : 0n,
              )
            : 0;

    return (
        <Link
            href={`/launchpad/v4/${token.address}`}
            className="arc-card group flex flex-col gap-3 p-4 transition-colors hover:border-arc-primary/40"
        >
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold">
                        {token.name ?? "Unnamed"}{" "}
                        <span className="text-arc-text-muted">{token.symbol ?? ""}</span>
                    </div>
                    <div className="truncate text-xs text-arc-text-faint">
                        {formatAddress(token.address)}
                    </div>
                </div>
                <span
                    className={cn(
                        "shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider",
                        token.poolInitialized
                            ? "border-arc-success/40 bg-arc-success/10 text-arc-success"
                            : "border-arc-border bg-arc-surface text-arc-text-muted",
                    )}
                >
                    {token.poolInitialized ? "Pool live" : "Pool pending"}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-arc-border bg-arc-bg px-3 py-2">
                    <div className="text-arc-text-muted">Snipe tax (start)</div>
                    <div className="mt-0.5 font-medium">
                        {(token.snipeStartBps / 100).toFixed(2)}%
                    </div>
                </div>
                <div className="rounded-lg border border-arc-border bg-arc-bg px-3 py-2">
                    <div className="text-arc-text-muted">Creator alloc</div>
                    <div className="mt-0.5 font-medium">
                        {(token.creatorBps / 100).toFixed(2)}%
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-arc-text-muted">
                {decayed || token.snipeStartBps === 0 ? (
                    <>
                        <ShieldOff className="h-3.5 w-3.5" />
                        <span>No active snipe tax</span>
                    </>
                ) : (
                    <>
                        <ShieldCheck className="h-3.5 w-3.5 text-arc-primary" />
                        <span>
                            Anti-sniper active{" "}
                            <Clock className="ml-1 inline h-3 w-3" /> {formatRemaining(remaining)}{" "}
                            left
                        </span>
                    </>
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
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
