import { ArrowLeft, BarChart3, Coins, Repeat, Rocket, Users } from "lucide-react";
import Link from "next/link";
import {
    formatUsdcGas,
    getAggregateStats,
    getGoldskyCreatorFees,
    getGoldskyStats,
    type CreatorFeeRow,
    type StatsSnapshot,
} from "@/lib/stats";
import { getBridgeRouteVolume, type BridgeRouteVolume } from "@/lib/keeperPersistence";
import { cctpDomainLabel } from "@/lib/cctp";
import {
    getLatestPersistedSnapshot,
    getSnapshotHistory,
    insertSnapshot,
} from "@/lib/statsPersistence";

export const metadata = {
    title: "Stats",
    description:
        "Live activity on Arcade: USDC gas paid through the protocol, transactions routed, unique wallets, tokens launched on Arc.",
};

/**
 * Public activity dashboard.
 *
 * Read order:
 *   1. Latest persisted snapshot from Postgres (canonical, hourly cron).
 *   2. Live RPC scan as a one-shot fallback when the DB is empty.
 *
 * The persisted path lets the page survive contract redeploys: even if
 * the live RPC scan can only see the last MAX_TOTAL_BLOCKS of history,
 * the persistent row keeps the cumulative numbers monotonically growing.
 * The fallback path bootstraps the DB on first attach so the page never
 * shows zeros while we wait for the next hourly cron tick.
 *
 * MVP estimation: until a real indexer (Ponder) lands, the USDC gas
 * number is an estimate (txCount * average gas cost). We surface this
 * disclosure inline so the dashboard never overstates reality.
 */
// Was revalidate = 300 (5-minute ISR cache). Dropped to 30 s after the
// 2026-06-14 stats fix shipped: a manual cron trigger persists a fresh
// row but /stats kept serving the previous one for 5 minutes, which
// made it look like the volume + gas math was still broken. Reads from
// Postgres are cheap (one SELECT + one LIMIT 720) so a 30 s ceiling is
// well inside the dashboard's expected freshness without adding load.
export const revalidate = 30;

const HISTORY_WINDOW_DAYS = 30;
const HISTORY_WINDOW_MS = HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export default async function StatsPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string }>;
}) {
    // /stats is shared: reachable from the public home AND from the admin
    // hub. When the admin hub links here it appends ?from=admin so the
    // back arrow returns to /admin instead of bouncing the owner all the
    // way out to the public home.
    const { from } = await searchParams;
    const backHref = from === "admin" ? "/admin" : "/";
    const backLabel = from === "admin" ? "Admin" : "Home";

    // Headline now comes from the Goldsky subgraph (Global running totals):
    // volume / txs / unique wallets / launched / graduated. It covers curve +
    // V3 + V4; the only gap is legacy V2 pairs (a minor slice), so the numbers
    // read slightly LOWER than the old RPC scan but are live + free. Falls back
    // to the persisted DB snapshot, then a live RPC scan, if the subgraph is
    // unset/behind. The 500k-block × ~50-contract getLogs scan is now only a
    // last-resort fallback, not the default.
    const persisted = await getLatestPersistedSnapshot();
    const goldsky = await getGoldskyStats();
    let snap: StatsSnapshot;
    let usingPersisted = false;
    if (goldsky) {
        snap = goldsky;
        // Keep the DB history (if any) for the delta + sparkline.
        usingPersisted = !!persisted;
    } else if (persisted) {
        snap = persisted;
        usingPersisted = true;
    } else {
        snap = await getAggregateStats();
        // Fire-and-forget bootstrap of the first row so the next render
        // hits the fast path. Failures are non-fatal; the cron will
        // retry hourly anyway.
        void insertSnapshot(snap, "fallback").catch(() => {});
    }
    // Graduated-token count (from whichever snapshot carries it; the RPC path
    // does not, so fall back to the subgraph value explicitly).
    const graduated = goldsky?.tokensGraduated ?? snap.tokensGraduated ?? null;

    // M3 breakdowns (additive, each hides when empty):
    //   - top creators by attributable volume + estimated fee (subgraph)
    //   - bridged USDC volume per CCTP source route (keeper DB)
    // Both soft-fail to [] so a missing subgraph / DB never breaks the page.
    const [creatorFees, bridgeRoutes] = await Promise.all([
        getGoldskyCreatorFees(8).catch(() => [] as CreatorFeeRow[]),
        getBridgeRouteVolume().catch(() => [] as BridgeRouteVolume[]),
    ]);

    // History window for the delta + sparkline. Empty when the DB isn't
    // configured yet — the rest of the page renders without it.
    const sinceIso = new Date(Date.now() - HISTORY_WINDOW_MS).toISOString();
    const history = usingPersisted ? await getSnapshotHistory(sinceIso, 720) : [];
    const oldest = history[0];
    const deltaVolume = oldest
        ? snap.volumeUsdcMicros - oldest.volumeUsdcMicros
        : null;
    const deltaTxs = oldest ? snap.txCount - oldest.txCount : null;

    return (
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
            <Link
                href={backHref}
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> {backLabel}
            </Link>

            <header className="mb-10">
                <h1 className="text-3xl font-semibold sm:text-5xl">
                    Activity on{" "}
                    <span className="bg-gradient-to-r from-arc-primary to-arc-text bg-clip-text text-transparent">
                        Arcade
                    </span>
                </h1>
                <p className="mt-3 text-sm text-arc-text-muted sm:text-base">
                    Live attribution of Arcade&apos;s contribution to Arc,
                    Circle&apos;s EVM L1. Snapshots are written hourly by a
                    GitHub Actions cron and the page refreshes its read
                    every 30 seconds.
                </p>
                {usingPersisted && persisted?.persistedAtIso && (
                    <p className="mt-2 text-[11px] uppercase tracking-wider text-arc-text-faint">
                        Last snapshot: {formatRelativeTime(persisted.persistedAtIso)}{" "}
                        · Block {snap.asOfBlock.toString()}
                    </p>
                )}
            </header>

            <section className="mb-10 rounded-3xl border border-arc-border bg-arc-bg-elevated p-8 sm:p-10">
                <div className="text-xs uppercase tracking-wider text-arc-text-muted">
                    USDC gas paid through Arcade contracts
                </div>
                <div className="mt-2 text-5xl font-semibold tabular-nums sm:text-7xl">
                    {formatUsdcGas(snap.estimatedUsdcGasMicros)}
                </div>
                <div className="mt-3 text-xs text-arc-text-faint">
                    Estimate based on transaction count and typical Arc gas cost.
                    A precise meter ships with the indexer roadmap. Snapshot at
                    block {snap.asOfBlock.toString()}.
                </div>
            </section>

            <section className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <MetricCard
                    icon={<Repeat className="h-5 w-5" />}
                    label="Transactions routed"
                    value={snap.txCount.toLocaleString("en-US")}
                    delta={
                        deltaTxs !== null && deltaTxs > 0
                            ? `+${deltaTxs.toLocaleString("en-US")} / ${HISTORY_WINDOW_DAYS}d`
                            : undefined
                    }
                />
                <MetricCard
                    icon={<Users className="h-5 w-5" />}
                    label="Unique wallets"
                    value={snap.uniqueWallets.toLocaleString("en-US")}
                />
                <MetricCard
                    icon={<Rocket className="h-5 w-5" />}
                    label="Tokens launched"
                    value={(
                        snap.tokensLaunched +
                        snap.v4TokensLaunched +
                        snap.v4HookLaunches
                    ).toLocaleString("en-US")}
                    note={
                        snap.v4HookLaunches > 0
                            ? `Includes ${snap.v4HookLaunches.toLocaleString("en-US")} on the V4 ArcadeHook.`
                            : undefined
                    }
                />
                {graduated !== null && (
                    <MetricCard
                        icon={<Rocket className="h-5 w-5" />}
                        label="Tokens graduated"
                        value={graduated.toLocaleString("en-US")}
                        note="Curve tokens that migrated into an on-chain pool (from the subgraph)."
                    />
                )}
                <MetricCard
                    icon={<BarChart3 className="h-5 w-5" />}
                    label="Total volume routed"
                    value={formatUsdcGas(snap.volumeUsdcMicros)}
                    delta={
                        deltaVolume !== null && deltaVolume > 0n
                            ? `+${formatUsdcGas(deltaVolume)} / ${HISTORY_WINDOW_DAYS}d`
                            : undefined
                    }
                    note="Cumulative $ value of every Buy + Sell across the launchpad and the AMM, summed across all generations."
                />
                <MetricCard
                    icon={<Coins className="h-5 w-5" />}
                    label="Native settlement"
                    value="USDC"
                    note="Every fee, every reward, every protocol revenue line."
                />
            </section>

            {creatorFees.length > 0 && (
                <section className="mb-10 rounded-2xl border border-arc-border bg-arc-bg-elevated p-6 sm:p-8">
                    <h2 className="text-base font-semibold text-arc-text">
                        Top creators by fees earned
                    </h2>
                    <p className="mt-1 text-xs text-arc-text-faint">
                        Estimated creator fees: ~0.30% of bonding-curve volume
                        (the creator&apos;s share of the 1% curve fee) plus ~0.80%
                        of graduated V3-pool volume. A floor: post-graduation V2
                        pair volume is not yet indexed.
                    </p>
                    <div className="mt-4 overflow-x-auto">
                        <table className="w-full min-w-[420px] text-sm">
                            <thead>
                                <tr className="text-left text-[10px] uppercase tracking-wider text-arc-text-muted">
                                    <th className="pb-2 font-medium">Creator</th>
                                    <th className="pb-2 text-right font-medium">Tokens</th>
                                    <th className="pb-2 text-right font-medium">Volume</th>
                                    <th className="pb-2 text-right font-medium">Fees (est.)</th>
                                </tr>
                            </thead>
                            <tbody className="tabular-nums">
                                {creatorFees.map((c) => (
                                    <tr
                                        key={c.creator}
                                        className="border-t border-arc-border/60"
                                    >
                                        <td className="py-2 font-mono text-xs text-arc-text">
                                            {shortAddr(c.creator)}
                                        </td>
                                        <td className="py-2 text-right text-arc-text-muted">
                                            {c.tokenCount.toLocaleString("en-US")}
                                        </td>
                                        <td className="py-2 text-right text-arc-text-muted">
                                            {formatUsdcGas(c.volumeMicros)}
                                        </td>
                                        <td className="py-2 text-right font-medium text-arc-success">
                                            {formatUsdcGas(c.feeMicros)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {bridgeRoutes.length > 0 && (
                <section className="mb-10 rounded-2xl border border-arc-border bg-arc-bg-elevated p-6 sm:p-8">
                    <h2 className="text-base font-semibold text-arc-text">
                        Bridged in by route
                    </h2>
                    <p className="mt-1 text-xs text-arc-text-faint">
                        USDC bridged into Arc via Circle CCTP, grouped by source
                        chain. Counts keeper-relayed bridge-and-buys (each backed
                        by a Circle-attested burn).
                    </p>
                    <div className="mt-4 overflow-x-auto">
                        <table className="w-full min-w-[360px] text-sm">
                            <thead>
                                <tr className="text-left text-[10px] uppercase tracking-wider text-arc-text-muted">
                                    <th className="pb-2 font-medium">Source route</th>
                                    <th className="pb-2 text-right font-medium">Bridges</th>
                                    <th className="pb-2 text-right font-medium">Volume</th>
                                </tr>
                            </thead>
                            <tbody className="tabular-nums">
                                {bridgeRoutes.map((r) => (
                                    <tr
                                        key={r.srcDomain}
                                        className="border-t border-arc-border/60"
                                    >
                                        <td className="py-2 text-arc-text">
                                            {cctpDomainLabel(r.srcDomain)}
                                            <span className="ml-2 text-arc-text-muted">
                                                &rarr; Arc
                                            </span>
                                        </td>
                                        <td className="py-2 text-right text-arc-text-muted">
                                            {r.count.toLocaleString("en-US")}
                                        </td>
                                        <td className="py-2 text-right font-medium text-arc-text">
                                            {formatUsdcGas(r.volumeMicros)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            <section className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-6 text-sm text-arc-text-muted sm:p-8">
                <h2 className="text-base font-semibold text-arc-text">Methodology</h2>
                <ul className="mt-4 list-disc space-y-2 pl-5">
                    <li>
                        Snapshots are persisted hourly to Postgres so the
                        time-series and cumulative totals survive every
                        contract redeploy. {usingPersisted
                            ? "This page is reading the latest persisted row."
                            : "Postgres is not yet attached; this page is rendering a one-shot live RPC scan and seeding the first row."}
                    </li>
                    <li>
                        Transaction and wallet counts come from a server-side
                        eth_getLogs scan of every Arcade contract on Arc testnet
                        (chainId 5042002), chunked in 5,000-block windows. The
                        scan covers V2 (router + factory + launchpad), V3 (router,
                        factory, quoter, NPM, locker, zap) and V4 surfaces; every
                        prior-generation address is included so the cumulative
                        count keeps growing past a fresh deploy.
                    </li>
                    <li>
                        Volume sums USDC moved across launchpad Buy / Sell, every
                        Arcade V3 pool Swap (USDC side, absolute value), and every
                        Arcade V2 pair Swap (USDC side, in + out). V3 multi-hop
                        swaps emit one Swap per leg so a USDC→A→USDC round-trip
                        counts each leg — the dashboard semantic is &quot;USDC
                        routed&quot; not &quot;round-trip USDC&quot;.
                    </li>
                    <li>
                        USDC gas paid is an estimate: transaction count multiplied
                        by an empirical average of gasUsed and gasPrice on Arc. It is
                        not a per-transaction sum of gasUsed * effectiveGasPrice.
                    </li>
                    <li>
                        Token-launch count includes both the V2 bonding-curve
                        launchpad and the V4 hook launchpad.
                    </li>
                    <li>
                        The page is rendered server-side and cached for 30
                        seconds. Refresh more frequently and you get the same
                        cached snapshot back.
                    </li>
                    {snap.truncated && (
                        <li className="text-arc-warn">
                            Heads-up: this scan hit the RPC range cap on at least
                            one window. Numbers may be undercounted. The indexer
                            roadmap resolves this.
                        </li>
                    )}
                </ul>
            </section>
        </div>
    );
}

/** Human-friendly "X min ago" rendering for the snapshot freshness
 *  badge. Falls back to a short ISO date when the persisted timestamp
 *  is more than a day old (the cron is broken or paused if we ever
 *  see that, but better to render something than collapse). */
function formatRelativeTime(iso: string): string {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const sec = Math.max(0, Math.floor((now - then) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} d ago`;
    return new Date(iso).toISOString().slice(0, 10);
}

/** 0x1234…abcd short form for a wallet address column. */
function shortAddr(a: string): string {
    if (!a || a.length < 10) return a;
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function MetricCard({
    icon,
    label,
    value,
    note,
    delta,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    note?: string;
    delta?: string;
}) {
    return (
        <div className="arc-card p-5">
            {/* Sky-400 to match the Send/Receive shortcuts in the header
                wallet widget - the deeper arc-primary palette read as the
                same flat navy as the card itself and the icons disappeared.
                bg-sky-400/10 mirrors the HeaderWalletWidget rest state. */}
            <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-400">
                {icon}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">
                {label}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
            {delta && (
                <div className="mt-1 text-[10px] font-medium tabular-nums text-arc-success">
                    {delta}
                </div>
            )}
            {note && <div className="mt-2 text-[10px] text-arc-text-faint">{note}</div>}
        </div>
    );
}
