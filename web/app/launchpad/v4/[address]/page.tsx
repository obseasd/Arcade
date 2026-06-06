"use client";

import {
    ArrowLeft,
    Clock,
    ExternalLink,
    Lock,
    ShieldCheck,
    ShieldOff,
    User,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, isAddress, parseAbiItem } from "viem";
import { usePublicClient, useReadContract } from "wagmi";
import { V4_LAUNCHPAD_ABI } from "@/lib/abis/v4Launchpad";
import { ADDRESSES, V4_ENABLED } from "@/lib/constants";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { useWatchEvent } from "@/lib/hooks/useWatchEvent";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { Skeleton } from "@/components/ui/Skeleton";
import { V4SwapPanel } from "@/components/launchpad/v4/V4SwapPanel";
import { cn, formatAddress, formatRemaining } from "@/lib/utils";

const TOKEN_LAUNCHED_EVT = parseAbiItem(
    "event TokenLaunched(address indexed token, address indexed creator, uint16 snipeStartBps, uint32 snipeDecaySeconds, uint64 launchedAt, uint16 creatorBps, string name, string symbol, string metadataURI)",
);
const POOL_INITIALIZED_EVT = parseAbiItem(
    "event PoolInitialized(address indexed token, address indexed pool, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, int256 liquidityDelta)",
);

const CHUNK = 1_000n;
const MAX_BACK = 500_000n;

interface TimelineEntry {
    kind: "launched" | "poolInit";
    blockNumber: bigint;
    txHash: string;
    sqrtPriceX96?: bigint;
    tickLower?: number;
    tickUpper?: number;
}

export default function V4TokenDetailPage() {
    if (!V4_ENABLED) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="rounded-2xl border border-arc-border bg-arc-surface p-8 text-center">
                    <Lock className="mx-auto h-8 w-8 text-arc-text-muted" />
                    <h1 className="mt-4 text-xl font-semibold">V4 not enabled</h1>
                    <p className="mt-2 text-sm text-arc-text-muted">
                        Set <code>NEXT_PUBLIC_V4_ENABLED=1</code> in env.
                    </p>
                </div>
            </div>
        );
    }
    return <V4DetailInner />;
}

function V4DetailInner() {
    const params = useParams();
    const addressParam = (params.address as string) ?? "";
    const isValid = isAddress(addressParam);
    const token = addressParam as Address;

    const launchpad = ADDRESSES.v4Launchpad;
    const publicClient = usePublicClient();

    const launchQ = useReadContract({
        address: launchpad,
        abi: V4_LAUNCHPAD_ABI,
        functionName: "getLaunch",
        args: isValid ? [token] : undefined,
        query: { enabled: isValid },
    });
    const nameQ = useReadContract({
        address: isValid ? token : undefined,
        abi: erc20Abi,
        functionName: "name",
        query: { enabled: isValid },
    });
    const symbolQ = useReadContract({
        address: isValid ? token : undefined,
        abi: erc20Abi,
        functionName: "symbol",
        query: { enabled: isValid },
    });
    const poolAllocationQ = useReadContract({
        address: launchpad,
        abi: V4_LAUNCHPAD_ABI,
        functionName: "poolAllocation",
        args: isValid ? [token] : undefined,
        query: { enabled: isValid },
    });
    const currentSnipeBpsQ = useReadContract({
        address: launchpad,
        abi: V4_LAUNCHPAD_ABI,
        functionName: "currentSnipeBps",
        args: isValid ? [token] : undefined,
        query: { enabled: isValid, refetchInterval: 10_000 },
    });

    const launch = launchQ.data as
        | {
              token: Address;
              creator: Address;
              poolKey: {
                  currency0: Address;
                  currency1: Address;
                  fee: number;
                  tickSpacing: number;
                  hooks: Address;
              };
              snipeStartBps: number;
              snipeDecaySeconds: number;
              launchedAt: bigint;
              creatorBps: number;
          }
        | undefined;

    // Pool is initialised once the stored PoolKey has a non-zero currency0
    // (matches the contract's "already initialised" sentinel).
    const poolInitialised =
        !!launch &&
        launch.poolKey.currency0 !== "0x0000000000000000000000000000000000000000";

    const { image } = useTokenImage(isValid ? token : undefined);

    // Live: any TokenLaunched / PoolInitialized re-fetches.
    useWatchEvent({
        address: launchpad,
        event: TOKEN_LAUNCHED_EVT,
        onLogs: () => {
            launchQ.refetch();
            poolAllocationQ.refetch();
        },
    });
    useWatchEvent({
        address: launchpad,
        event: POOL_INITIALIZED_EVT,
        onLogs: () => {
            launchQ.refetch();
            poolAllocationQ.refetch();
        },
    });

    // Cold-path: chunked log scan to build a small timeline of launch + pool
    // init events for this specific token.
    const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
    useEffect(() => {
        if (!publicClient || !isValid) return;
        let cancelled = false;
        (async () => {
            try {
                const latest = await publicClient.getBlockNumber();
                const out: TimelineEntry[] = [];
                let end = latest;
                let walked = 0n;
                while (walked < MAX_BACK) {
                    const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
                    try {
                        const [launchLogs, initLogs] = await Promise.all([
                            publicClient.getLogs({
                                address: launchpad,
                                event: TOKEN_LAUNCHED_EVT,
                                args: { token } as Record<string, unknown>,
                                fromBlock: start,
                                toBlock: end,
                            }),
                            publicClient.getLogs({
                                address: launchpad,
                                event: POOL_INITIALIZED_EVT,
                                args: { token } as Record<string, unknown>,
                                fromBlock: start,
                                toBlock: end,
                            }),
                        ]);
                        for (const log of launchLogs) {
                            out.push({
                                kind: "launched",
                                blockNumber: log.blockNumber,
                                txHash: log.transactionHash,
                            });
                        }
                        for (const log of initLogs) {
                            out.push({
                                kind: "poolInit",
                                blockNumber: log.blockNumber,
                                txHash: log.transactionHash,
                                sqrtPriceX96: log.args.sqrtPriceX96 as bigint,
                                tickLower: Number(log.args.tickLower as number),
                                tickUpper: Number(log.args.tickUpper as number),
                            });
                        }
                    } catch {
                        break;
                    }
                    if (start === 0n) break;
                    walked += end - start + 1n;
                    end = start - 1n;
                }
                if (!cancelled) {
                    out.sort((a, b) => Number(b.blockNumber - a.blockNumber));
                    setTimeline(out);
                }
            } catch {
                /* swallow */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [publicClient, isValid, launchpad, token]);

    if (!isValid) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="arc-card p-8 text-center text-arc-text-muted">
                    Invalid token address.
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
            <div className="mb-6 flex items-center gap-3">
                <Link
                    href="/launchpad/v4/list"
                    className="rounded-lg border border-arc-border bg-arc-surface p-2 hover:border-arc-primary/40"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Link>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <TokenIcon
                        image={image}
                        symbol={(symbolQ.data as string) ?? ""}
                        size={48}
                    />
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="truncate text-xl font-semibold sm:text-2xl">
                                {(nameQ.data as string) ?? <Skeleton className="h-6 w-32" />}
                            </h1>
                            <span className="rounded-md border border-arc-primary/40 bg-arc-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-primary">
                                V4
                            </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-arc-text-muted">
                            <span>{(symbolQ.data as string) ?? "..."}</span>
                            <span>·</span>
                            <span className="truncate">{formatAddress(token)}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
                <div className="space-y-4 lg:col-span-2">
                    <PoolStatusCard
                        poolInitialised={poolInitialised}
                        poolAllocation={poolAllocationQ.data as bigint | undefined}
                        symbol={symbolQ.data as string | undefined}
                    />
                    <AntiSniperCard
                        snipeStartBps={launch?.snipeStartBps ?? 0}
                        snipeDecaySeconds={launch?.snipeDecaySeconds ?? 0}
                        currentSnipeBps={Number((currentSnipeBpsQ.data as bigint | undefined) ?? 0n)}
                        launchedAt={launch?.launchedAt ?? 0n}
                    />
                    <TimelineCard entries={timeline} />
                </div>

                <div className="space-y-4">
                    {poolInitialised ? (
                        <V4SwapPanel token={token} symbol={symbolQ.data as string | undefined} />
                    ) : (
                        <ActionsCard token={token} poolInitialised={poolInitialised} />
                    )}
                    <LaunchInfoCard launch={launch} />
                </div>
            </div>
        </div>
    );
}

// -----------------------------------------------------------------------
// Cards
// -----------------------------------------------------------------------

function PoolStatusCard({
    poolInitialised,
    poolAllocation,
    symbol,
}: {
    poolInitialised: boolean;
    poolAllocation: bigint | undefined;
    symbol: string | undefined;
}) {
    return (
        <div className="arc-card p-5">
            <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium text-arc-text-muted">Pool status</h2>
                <span
                    className={cn(
                        "rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider",
                        poolInitialised
                            ? "border-arc-success/40 bg-arc-success/10 text-arc-success"
                            : "border-arc-border bg-arc-surface text-arc-text-muted",
                    )}
                >
                    {poolInitialised ? "Live" : "Pending"}
                </span>
            </div>
            {poolInitialised ? (
                <div className="text-sm">
                    The V4 pool is initialised and tradeable. The launch token is locked
                    single-sided so buyers move the price up the curve.
                </div>
            ) : (
                <div className="text-sm text-arc-text-muted">
                    Pool not yet initialised. The creator can complete step 2 (initialise pool)
                    via the launch wizard to make the token tradeable.
                </div>
            )}
            <div className="mt-4 rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm">
                <div className="text-arc-text-muted">Tokens reserved for the pool</div>
                <div className="mt-0.5 font-medium">
                    {poolAllocation === undefined ? (
                        <Skeleton className="h-4 w-32" />
                    ) : (
                        <>
                            {Number(formatUnits(poolAllocation, 18)).toLocaleString(undefined, {
                                maximumFractionDigits: 0,
                            })}{" "}
                            {symbol ?? ""}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function AntiSniperCard({
    snipeStartBps,
    snipeDecaySeconds,
    currentSnipeBps,
    launchedAt,
}: {
    snipeStartBps: number;
    snipeDecaySeconds: number;
    currentSnipeBps: number;
    launchedAt: bigint;
}) {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const decayed =
        snipeDecaySeconds > 0 && nowSec >= launchedAt + BigInt(snipeDecaySeconds);
    const remaining = Number(
        snipeDecaySeconds > 0 && launchedAt + BigInt(snipeDecaySeconds) > nowSec
            ? launchedAt + BigInt(snipeDecaySeconds) - nowSec
            : 0n,
    );
    const active = snipeStartBps > 0 && !decayed;

    return (
        <div className="arc-card p-5">
            <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium text-arc-text-muted">Anti-sniper</h2>
                {active ? (
                    <div className="flex items-center gap-1 rounded-md border border-arc-primary/40 bg-arc-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-primary">
                        <ShieldCheck className="h-3 w-3" /> Active
                    </div>
                ) : (
                    <div className="flex items-center gap-1 rounded-md border border-arc-border bg-arc-surface px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-text-muted">
                        <ShieldOff className="h-3 w-3" /> Inactive
                    </div>
                )}
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-lg border border-arc-border bg-arc-bg px-3 py-2">
                    <div className="text-arc-text-muted">Starting tax</div>
                    <div className="mt-0.5 font-medium">
                        {(snipeStartBps / 100).toFixed(2)}%
                    </div>
                </div>
                <div className="rounded-lg border border-arc-border bg-arc-bg px-3 py-2">
                    <div className="text-arc-text-muted">Current tax</div>
                    <div className="mt-0.5 font-medium">
                        {(currentSnipeBps / 100).toFixed(2)}%
                    </div>
                </div>
                <div className="rounded-lg border border-arc-border bg-arc-bg px-3 py-2">
                    <div className="flex items-center gap-1 text-arc-text-muted">
                        <Clock className="h-3 w-3" /> Time left
                    </div>
                    <div className="mt-0.5 font-medium">{formatRemaining(remaining)}</div>
                </div>
            </div>
        </div>
    );
}

function LaunchInfoCard({
    launch,
}: {
    launch:
        | {
              creator: Address;
              creatorBps: number;
              launchedAt: bigint;
          }
        | undefined;
}) {
    return (
        <div className="arc-card p-5">
            <h2 className="mb-3 text-sm font-medium text-arc-text-muted">Launch info</h2>
            <div className="space-y-3 text-sm">
                <div>
                    <div className="text-arc-text-muted">Creator</div>
                    <div className="mt-0.5 flex items-center gap-1 font-medium">
                        <User className="h-3 w-3" />
                        {launch ? formatAddress(launch.creator) : <Skeleton className="h-4 w-32" />}
                    </div>
                </div>
                <div>
                    <div className="text-arc-text-muted">Creator allocation</div>
                    <div className="mt-0.5 font-medium">
                        {launch ? `${(launch.creatorBps / 100).toFixed(2)}%` : <Skeleton className="h-4 w-16" />}
                    </div>
                </div>
                <div>
                    <div className="text-arc-text-muted">Launched at</div>
                    <div className="mt-0.5 font-medium">
                        {launch && launch.launchedAt > 0n ? (
                            new Date(Number(launch.launchedAt) * 1000).toLocaleString()
                        ) : (
                            <Skeleton className="h-4 w-40" />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function ActionsCard({
    token,
    poolInitialised,
}: {
    token: Address;
    poolInitialised: boolean;
}) {
    return (
        <div className="arc-card p-5">
            <h2 className="mb-3 text-sm font-medium text-arc-text-muted">Actions</h2>
            <div className="space-y-2">
                {!poolInitialised && (
                    <Link
                        href="/launchpad/v4"
                        className="block rounded-xl border border-arc-primary/40 bg-arc-primary/10 px-4 py-2 text-center text-sm font-medium text-arc-primary hover:bg-arc-primary/20"
                    >
                        Initialise pool (creator)
                    </Link>
                )}
                <button
                    disabled
                    className="block w-full rounded-xl border border-arc-border bg-arc-surface px-4 py-2 text-center text-sm text-arc-text-muted disabled:cursor-not-allowed"
                    title="Swap UI ships in Session 4"
                >
                    Swap (coming soon)
                </button>
                <div className="pt-2 text-xs text-arc-text-muted">
                    Token contract: {formatAddress(token)}
                </div>
            </div>
        </div>
    );
}

function TimelineCard({ entries }: { entries: TimelineEntry[] }) {
    return (
        <div className="arc-card p-5">
            <h2 className="mb-3 text-sm font-medium text-arc-text-muted">Timeline</h2>
            {entries.length === 0 ? (
                <div className="text-sm text-arc-text-muted">No events scanned yet.</div>
            ) : (
                <div className="space-y-2">
                    {entries.map((e) => (
                        <div
                            key={e.txHash + e.kind}
                            className="flex items-center justify-between rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm"
                        >
                            <div className="flex items-center gap-2">
                                <span
                                    className={cn(
                                        "rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
                                        e.kind === "launched"
                                            ? "border border-arc-primary/40 bg-arc-primary/10 text-arc-primary"
                                            : "border border-arc-success/40 bg-arc-success/10 text-arc-success",
                                    )}
                                >
                                    {e.kind === "launched" ? "Token launched" : "Pool initialised"}
                                </span>
                                <span className="text-xs text-arc-text-muted">
                                    block #{e.blockNumber.toString()}
                                </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-arc-text-faint">
                                <span>{e.txHash.slice(0, 10)}...</span>
                                <ExternalLink className="h-3 w-3" />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// formatRemaining lives in @/lib/utils now.
