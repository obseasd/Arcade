import { ArrowLeft, Coins, Repeat, Rocket, Users } from "lucide-react";
import Link from "next/link";
import { formatUsdcGas, getAggregateStats } from "@/lib/stats";

export const metadata = {
    title: "Stats",
    description:
        "Live activity on Arcade: USDC gas paid through the protocol, transactions routed, unique wallets, tokens launched on Arc.",
};

/**
 * Public activity dashboard.
 *
 * Designed to be the canonical place Circle / Arc team / partners look up
 * Arcade's USDC-gas footprint, transaction throughput, and token issuance
 * rate. Numbers are server-rendered with a 5-minute ISR cache so the page
 * is fast and the underlying RPC scan does not hit on every visit.
 *
 * MVP estimation: until we ship a real indexer (Ponder), the USDC gas
 * number is an estimate (txCount * average gas cost). We surface this
 * disclosure inline so the dashboard never overstates reality.
 */
export const revalidate = 300;

export default async function StatsPage() {
    const snap = await getAggregateStats();

    return (
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
            <Link
                href="/"
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> Home
            </Link>

            <header className="mb-10">
                <h1 className="text-3xl font-semibold sm:text-5xl">
                    Activity on{" "}
                    <span className="bg-gradient-to-r from-arc-primary to-arc-text bg-clip-text text-transparent">
                        Arcade
                    </span>
                </h1>
                <p className="mt-3 text-sm text-arc-text-muted sm:text-base">
                    Live attribution of Arcade&apos;s contribution to Arc, Circle&apos;s
                    EVM L1. Updated every 5 minutes.
                </p>
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

            <section className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                    icon={<Repeat className="h-5 w-5" />}
                    label="Transactions routed"
                    value={snap.txCount.toLocaleString("en-US")}
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
                <MetricCard
                    icon={<Coins className="h-5 w-5" />}
                    label="Native settlement"
                    value="USDC"
                    note="Every fee, every reward, every protocol revenue line."
                />
            </section>

            <section className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-6 text-sm text-arc-text-muted sm:p-8">
                <h2 className="text-base font-semibold text-arc-text">Methodology</h2>
                <ul className="mt-4 list-disc space-y-2 pl-5">
                    <li>
                        Transaction and wallet counts come from a server-side
                        eth_getLogs scan of every Arcade contract on Arc testnet
                        (chainId 5042002), chunked in 50,000-block windows.
                    </li>
                    <li>
                        USDC gas paid is an estimate: transaction count multiplied
                        by an empirical average of gasUsed and gasPrice on Arc.
                        Once the Ponder indexer lands, this becomes a precise sum
                        of every transaction&apos;s gasUsed * effectiveGasPrice.
                    </li>
                    <li>
                        Token-launch count includes both the V2 bonding-curve
                        launchpad and the V4 launchpad prototype (when deployed).
                    </li>
                    <li>
                        The page is rendered server-side and cached for 5 minutes.
                        Refresh more frequently and you get the same cached
                        snapshot back.
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

function MetricCard({
    icon,
    label,
    value,
    note,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    note?: string;
}) {
    return (
        <div className="arc-card p-5">
            <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-arc-primary-soft text-arc-primary">
                {icon}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-arc-text-muted">
                {label}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
            {note && <div className="mt-2 text-[10px] text-arc-text-faint">{note}</div>}
        </div>
    );
}
