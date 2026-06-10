"use client";

import Link from "next/link";
import {
    Activity,
    ChevronRight,
    LineChart,
    LogOut,
    Lock,
    ShieldAlert,
    UserCog,
} from "lucide-react";
import { useAccount, useReadContract } from "wagmi";
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
import { ADDRESSES } from "@/lib/constants";
import { cn, formatAddress } from "@/lib/utils";

/**
 * Admin landing page. Owner-only gate is enforced by reading
 * `escrow.owner()` and comparing against the connected wallet — same
 * pattern as the existing /admin/escrow page. The contract enforces the
 * real authorization on every write so a wallet spoof can only see
 * the menu, never execute anything destructive.
 *
 * Surfaces today:
 *  - Twitter Escrow V3 admin (pause/unpause, signer timelock,
 *    rescue, slot debug).
 *  - Observability / Sentry quick-links: links out to the Sentry
 *    dashboard with a status summary panel rendered server-side
 *    once the SENTRY_ORG_TOKEN env var is wired (audit A-6).
 *
 * Future entries land here as separate cards: V3 Locker admin
 * (recipient rotation, adminRescue), Launchpad governance (treasury
 * rotation, V2/V3 infra setters), and the V4 ArcadeHook console once
 * V4 mainnet ships.
 */

interface AdminCard {
    href: string;
    title: string;
    description: string;
    Icon: typeof Lock;
    status?: { label: string; tone: "ok" | "warn" | "danger" };
}

export default function AdminIndex() {
    const { address: account } = useAccount();
    const ownerQ = useReadContract({
        address: ADDRESSES.twitterEscrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "owner",
        query: { enabled: !!ADDRESSES.twitterEscrow },
    });
    const owner = ownerQ.data as `0x${string}` | undefined;
    const isOwner = !!account && !!owner && account.toLowerCase() === owner.toLowerCase();

    const cards: AdminCard[] = [
        {
            href: "/admin/escrow",
            title: "Twitter Escrow V3",
            description:
                "Pause / unpause, request + finalize signer rotation (24h timelock), rescue unattributed balances, debug slots.",
            Icon: Lock,
            status: { label: "Live", tone: "ok" },
        },
        {
            href: "/admin/observability",
            title: "Observability",
            description:
                "Sentry dashboard for swap / bridge / claim error rates, performance traces, release health. Free tier, hosted at sentry.io.",
            Icon: LineChart,
            status: { label: "Audit A-6", tone: "warn" },
        },
        {
            href: "/admin/governance",
            title: "Treasury & governance",
            description:
                "Rotate treasury address, manage V3 infra wiring, set V4 hook addresses when ready. Disabled until the rotation function lands on chain.",
            Icon: UserCog,
            status: { label: "Pending L-7", tone: "warn" },
        },
    ];

    return (
        <div className="mx-auto w-full max-w-4xl px-4 py-12">
            <header className="mb-8">
                <h1 className="text-3xl font-semibold tracking-tight text-arc-text">
                    Admin
                </h1>
                <p className="mt-2 text-sm text-arc-text-muted">
                    Owner-only surfaces. All writes are gated by the contracts
                    themselves; this index just lists the panels that exist.
                </p>
                {account && (
                    <div className="mt-4 flex items-center gap-2 rounded-xl border border-arc-border bg-white/[0.015] px-3 py-2 text-xs">
                        <span className="text-arc-text-faint">Connected:</span>
                        <span className="font-mono text-arc-text">
                            {formatAddress(account)}
                        </span>
                        {ownerQ.data && (
                            <span
                                className={cn(
                                    "ml-auto rounded-md px-2 py-0.5 font-medium",
                                    isOwner
                                        ? "bg-arc-success/20 text-arc-success"
                                        : "bg-arc-warn/20 text-arc-warn",
                                )}
                            >
                                {isOwner ? "OWNER" : "NOT OWNER"}
                            </span>
                        )}
                    </div>
                )}
                {!account && (
                    <div className="mt-4 flex items-center gap-2 rounded-xl border border-arc-warn/40 bg-arc-warn/10 px-3 py-2 text-xs text-arc-warn">
                        <ShieldAlert className="h-4 w-4" />
                        Connect the owner wallet to interact with the admin panels.
                    </div>
                )}
            </header>

            <div className="grid gap-3 sm:grid-cols-1">
                {cards.map((card) => (
                    <Link
                        key={card.href}
                        href={card.href}
                        className="group flex items-start gap-4 rounded-2xl border border-arc-border bg-white/[0.015] p-5 transition-colors hover:border-arc-cta-hover/60 hover:bg-white/[0.04]"
                    >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-arc-border bg-black/30">
                            <card.Icon className="h-5 w-5 text-arc-text" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <h2 className="text-base font-semibold text-arc-text">
                                    {card.title}
                                </h2>
                                {card.status && (
                                    <span
                                        className={cn(
                                            "rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                                            card.status.tone === "ok" &&
                                                "bg-arc-success/20 text-arc-success",
                                            card.status.tone === "warn" &&
                                                "bg-arc-warn/20 text-arc-warn",
                                            card.status.tone === "danger" &&
                                                "bg-arc-danger/20 text-arc-danger",
                                        )}
                                    >
                                        {card.status.label}
                                    </span>
                                )}
                            </div>
                            <p className="mt-1 text-sm text-arc-text-muted">
                                {card.description}
                            </p>
                        </div>
                        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-arc-text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-arc-text" />
                    </Link>
                ))}
            </div>

            <footer className="mt-12 border-t border-arc-border pt-6 text-xs text-arc-text-faint">
                <div className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5" />
                    Need to disconnect this session? Use the wallet widget in the
                    header — there is no admin-only logout here.
                </div>
                <Link
                    href="/"
                    className="mt-3 inline-flex items-center gap-1 text-arc-text-muted hover:text-arc-text"
                >
                    <LogOut className="h-3.5 w-3.5" />
                    Back to app
                </Link>
            </footer>
        </div>
    );
}
