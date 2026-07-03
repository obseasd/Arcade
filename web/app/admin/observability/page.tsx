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
} from "lucide-react";
import { cn } from "@/lib/utils";

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

export default function ObservabilityPage() {
    // Sentry is "on" only when a DSN is set. Without it the tracking helpers
    // no-op, so nothing is recorded and the dashboard links below point at an
    // empty project.
    const connected = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-12">
            <header className="mb-6">
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
                    Error and performance monitoring for Arcade&apos;s swap,
                    bridge, and claim flows, powered by Sentry. This page is the
                    jump-off point to the dashboards.
                </p>
            </header>

            {/* Connection status */}
            <section
                className={cn(
                    "rounded-2xl border p-5",
                    connected
                        ? "border-arc-success/40 bg-arc-success/5"
                        : "border-arc-warn/40 bg-arc-warn/5",
                )}
            >
                <div className="flex items-center gap-2">
                    <span
                        className={cn(
                            "h-2 w-2 rounded-full",
                            connected ? "bg-arc-success" : "bg-arc-warn",
                        )}
                    />
                    <h2 className="text-sm font-semibold text-arc-text">
                        {connected ? "Connected" : "Not connected yet"}
                    </h2>
                </div>
                {connected ? (
                    <p className="mt-2 text-xs text-arc-text-muted">
                        Telemetry is streaming to Sentry. Use the dashboards
                        below to triage errors and watch performance.
                    </p>
                ) : (
                    <p className="mt-2 text-xs text-arc-text-muted">
                        Sentry isn&apos;t wired up, so nothing is being recorded
                        yet and the links below open an empty project. To turn it
                        on: create a project at{" "}
                        <a
                            href="https://sentry.io/signup/"
                            className="text-arc-cta-hover hover:underline"
                            target="_blank"
                            rel="noreferrer"
                        >
                            sentry.io
                        </a>
                        , then set <code>NEXT_PUBLIC_SENTRY_DSN</code>,{" "}
                        <code>NEXT_PUBLIC_SENTRY_ORG</code> and{" "}
                        <code>NEXT_PUBLIC_SENTRY_PROJECT</code> in Vercel and
                        redeploy.
                    </p>
                )}
            </section>

            {/* Dashboards */}
            <section className="mt-8">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-arc-text-faint">
                    Dashboards{connected ? "" : " (available once connected)"}
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
        </div>
    );
}
