"use client";

import Link from "next/link";
import {
    Activity,
    AlertCircle,
    ArrowLeft,
    ArrowUpRight,
    Bell,
    Clock,
    LineChart,
    Server,
    ShieldCheck,
} from "lucide-react";

/**
 * Observability admin page (audit A-6). Surfaces the Sentry-backed
 * monitoring story for the team without exposing user-facing details.
 *
 * The actual Sentry wiring lives in lib/telemetry.ts (next phase).
 * Once installed, the `trackSwap` / `trackBridge` / `trackClaim`
 * helpers stream events into the Sentry project; this page is the
 * jump-off point to that dashboard plus a status panel that the
 * operator reads at a glance.
 *
 * Why server-side stats matter: the team needs a single screen that
 * answers "is anything obviously broken right now" without opening
 * 4 different vendors. Sentry covers errors + perf + releases; this
 * page links them all and surfaces the most recent incident summary
 * when the SENTRY_ORG_TOKEN env var is wired (read in a server-side
 * fetch, never sent to the client).
 */

const SENTRY_ORG = process.env.NEXT_PUBLIC_SENTRY_ORG ?? "arcade";
const SENTRY_PROJECT = process.env.NEXT_PUBLIC_SENTRY_PROJECT ?? "arcade-web";
const SENTRY_BASE_URL = `https://${SENTRY_ORG}.sentry.io`;

interface DashboardLink {
    title: string;
    description: string;
    href: string;
    Icon: typeof Activity;
}

const LINKS: DashboardLink[] = [
    {
        title: "Issues",
        description:
            "All open errors grouped by stack trace. Sorted by user impact. Triage entry point.",
        href: `${SENTRY_BASE_URL}/issues/?project=${SENTRY_PROJECT}`,
        Icon: AlertCircle,
    },
    {
        title: "Performance",
        description:
            "Transaction traces: quote latency per provider, swap submit → receipt, bridge attestation poll.",
        href: `${SENTRY_BASE_URL}/performance/?project=${SENTRY_PROJECT}`,
        Icon: LineChart,
    },
    {
        title: "Releases",
        description:
            "Per-commit error count + crash-free sessions. Catches regressions before users do.",
        href: `${SENTRY_BASE_URL}/releases/?project=${SENTRY_PROJECT}`,
        Icon: Clock,
    },
    {
        title: "Alerts",
        description:
            "Slack-bound alert rules: error rate spike, perf degradation, new issue in last release.",
        href: `${SENTRY_BASE_URL}/alerts/rules/?project=${SENTRY_PROJECT}`,
        Icon: Bell,
    },
];

const INSTRUMENTATION_POINTS = [
    {
        path: "components/swap/SwapCard.tsx",
        events: ["trackSwap(success)", "trackSwap(failure, errorClass)"],
        why: "Per-DEX success / failure rates, USD-weighted volume, slippage outcomes.",
    },
    {
        path: "components/bridge/BridgeCard.tsx",
        events: [
            "trackBridge(burn)",
            "trackBridge(attesting_timeout)",
            "trackBridge(mint_success)",
            "trackBridge(mint_revert)",
        ],
        why: "End-to-end bridge funnel. Identifies where users drop off (attestation stalls vs mint failures).",
    },
    {
        path: "app/api/twitter-callback/route.ts",
        events: [
            "trackClaim(oauth_complete)",
            "trackClaim(sig_issued)",
            "trackClaim(quota_hit)",
        ],
        why: "OAuth handshake health, sig issuance volume, rate-limit pressure.",
    },
    {
        path: "lib/routing/useRouteQuotes.ts",
        events: ["trackProviderTiming(provider, latencyMs)"],
        why: "Latency distribution per provider — catch a slow Synthra RPC before it tanks the aggregator.",
    },
];

export default function ObservabilityPage() {
    return (
        <div className="mx-auto w-full max-w-4xl px-4 py-12">
            <header className="mb-8">
                <Link
                    href="/admin"
                    className="mb-3 inline-flex items-center gap-1 text-xs text-arc-text-muted hover:text-arc-text"
                >
                    <ArrowLeft className="h-3 w-3" />
                    Back to admin
                </Link>
                <h1 className="text-3xl font-semibold tracking-tight text-arc-text">
                    Observability
                </h1>
                <p className="mt-2 max-w-2xl text-sm text-arc-text-muted">
                    Sentry-backed monitoring for swap, bridge, and claim flows.
                    Audit finding A-6 flagged the pre-existing zero-telemetry
                    state as a mainnet blocker: without it the team triages user
                    reports by guessing.
                </p>
            </header>

            <section className="rounded-2xl border border-arc-warn/40 bg-arc-warn/5 p-5">
                <div className="flex items-start gap-3">
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-arc-warn" />
                    <div>
                        <h2 className="text-sm font-semibold text-arc-text">
                            Setup status
                        </h2>
                        <p className="mt-1 text-xs text-arc-text-muted">
                            Sentry SDK + tracking helpers ship in commit{" "}
                            <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[10px]">
                                4470f8a+
                            </code>{" "}
                            but the operator still has to (a) create the Sentry
                            project, (b) set <code>NEXT_PUBLIC_SENTRY_DSN</code>{" "}
                            in Vercel, (c) set <code>NEXT_PUBLIC_SENTRY_ORG</code>{" "}
                            + <code>NEXT_PUBLIC_SENTRY_PROJECT</code> for the
                            dashboard links below. Without the DSN, telemetry
                            calls become no-ops — no errors, no events shipped.
                        </p>
                        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-arc-text-muted">
                            <li>
                                Sign up at{" "}
                                <a
                                    href="https://sentry.io/signup/"
                                    className="text-arc-cta-hover hover:underline"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    sentry.io
                                </a>{" "}
                                — free tier covers 10k events / mo (sufficient
                                for testnet + small prod).
                            </li>
                            <li>
                                Create a Next.js project. Copy the DSN and the
                                org / project slug shown after setup.
                            </li>
                            <li>
                                Vercel project settings → Environment Variables
                                → add the three NEXT_PUBLIC_SENTRY_* values.
                                Redeploy.
                            </li>
                            <li>
                                Click the dashboard links below to verify the
                                first event lands within ~30 s of a swap.
                            </li>
                        </ol>
                    </div>
                </div>
            </section>

            <section className="mt-8">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-arc-text-faint">
                    Dashboards
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                    {LINKS.map((link) => (
                        <a
                            key={link.title}
                            href={link.href}
                            target="_blank"
                            rel="noreferrer"
                            className="group flex items-start gap-3 rounded-xl border border-arc-border bg-white/[0.015] p-4 transition-colors hover:border-arc-cta-hover/40 hover:bg-white/[0.04]"
                        >
                            <link.Icon className="mt-0.5 h-5 w-5 shrink-0 text-arc-text" />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1 text-sm font-semibold text-arc-text">
                                    {link.title}
                                    <ArrowUpRight className="h-3 w-3 text-arc-text-faint group-hover:text-arc-text" />
                                </div>
                                <p className="mt-0.5 text-[11px] leading-relaxed text-arc-text-muted">
                                    {link.description}
                                </p>
                            </div>
                        </a>
                    ))}
                </div>
            </section>

            <section className="mt-10">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-arc-text-faint">
                    Instrumentation points
                </h2>
                <div className="space-y-2">
                    {INSTRUMENTATION_POINTS.map((point) => (
                        <div
                            key={point.path}
                            className="rounded-xl border border-arc-border bg-white/[0.015] p-4"
                        >
                            <div className="flex items-center gap-2 font-mono text-xs text-arc-text">
                                <Server className="h-3 w-3 text-arc-text-faint" />
                                {point.path}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1">
                                {point.events.map((ev) => (
                                    <code
                                        key={ev}
                                        className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-arc-text-muted"
                                    >
                                        {ev}
                                    </code>
                                ))}
                            </div>
                            <p className="mt-2 text-[11px] text-arc-text-muted">
                                {point.why}
                            </p>
                        </div>
                    ))}
                </div>
            </section>

            <footer className="mt-12 border-t border-arc-border pt-6 text-xs text-arc-text-faint">
                When the DSN is wired, the page above becomes the team&apos;s
                daily-driver dashboard. Until then, the trackXxx helpers
                gracefully no-op so no Sentry vendor lock-in lands in the
                shipped binary.
            </footer>
        </div>
    );
}
