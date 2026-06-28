"use client";

import { useCallback, useEffect, useState } from "react";
import { Address } from "viem";
import { buildReferralLink } from "@/lib/referral";
import type { ReferralStats } from "@/lib/referralPersistence";
import { formatAddress } from "@/lib/utils";

const fmtUsd = (micros: string) =>
    `$${(Number(BigInt(micros)) / 1e6).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;

// Hide referred wallets that haven't traded a meaningful amount yet (< $0.01
// volume) — a wallet that connected via the link but never swapped.
const MIN_VOLUME_MICROS = 10_000n; // $0.01

/**
 * Referrals dashboard (portfolio tab). Shows the wallet's shareable referral
 * link plus claimed / pending totals and a per-referred-wallet breakdown
 * (volume, tx count, earned). Read-only — earnings accrue server-side and a
 * payout/claim flow lands in Phase 2.
 */
export function ReferralsPanel({ account }: { account: Address | undefined }) {
    const [stats, setStats] = useState<ReferralStats | null>(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!account) {
            setStats(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const res = await fetch(`/api/referral/stats?referrer=${account}`);
                const data = (await res.json()) as ReferralStats;
                if (!cancelled) setStats(data);
            } catch {
                /* soft-fail */
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [account]);

    const activeReferred = (stats?.referred ?? []).filter(
        (r) => BigInt(r.volumeUsdMicros) >= MIN_VOLUME_MICROS,
    );
    const link = account ? buildReferralLink(account) : "";
    const onCopy = useCallback(() => {
        if (!link) return;
        void navigator.clipboard?.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [link]);

    if (!account) {
        return (
            <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-8 text-center text-sm text-arc-text-muted">
                Connect your wallet to see your referrals.
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Share link */}
            <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5">
                <div className="text-sm font-semibold text-arc-text">Your referral link</div>
                <p className="mt-1 text-xs text-arc-text-muted">
                    Anyone who connects through this link is attributed to you. You earn
                    <span className="text-arc-text"> 10% of the protocol fees</span> they generate.
                </p>
                <div className="mt-3 flex items-center gap-2">
                    <input
                        readOnly
                        value={link}
                        onFocus={(e) => e.currentTarget.select()}
                        className="min-w-0 flex-1 truncate rounded-xl border border-arc-border bg-arc-bg px-3 py-2 text-sm text-arc-text outline-none"
                    />
                    <button
                        type="button"
                        onClick={onCopy}
                        className="arc-button-primary shrink-0 px-4 py-2 text-sm"
                    >
                        {copied ? "Copied" : "Copy"}
                    </button>
                </div>
            </div>

            {/* Totals */}
            <div className="grid grid-cols-3 gap-3">
                <Stat label="Claimed" value={fmtUsd(stats?.totalClaimedUsdMicros ?? "0")} className="text-arc-success" />
                <Stat label="Pending" value={fmtUsd(stats?.totalPendingUsdMicros ?? "0")} className="text-arc-warn" />
                <Stat label="Referred volume" value={fmtUsd(stats?.totalVolumeUsdMicros ?? "0")} />
            </div>

            {/* Per-referred table */}
            <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5">
                <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-semibold text-arc-text">
                        Referred wallets {stats ? `(${activeReferred.length})` : ""}
                    </div>
                </div>
                {loading && !stats ? (
                    <div className="py-6 text-center text-sm text-arc-text-muted">Loading…</div>
                ) : activeReferred.length === 0 ? (
                    <div className="py-6 text-center text-sm text-arc-text-muted">
                        No active referrals yet. Share your link to start earning.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm tabular-nums">
                            <thead>
                                <tr className="text-left text-xs uppercase tracking-wider text-arc-text-muted">
                                    <th className="pb-2 pr-3 font-medium">Wallet</th>
                                    <th className="pb-2 pr-3 text-right font-medium">Volume</th>
                                    <th className="pb-2 pr-3 text-right font-medium">Trades</th>
                                    <th className="pb-2 text-right font-medium">Earned</th>
                                </tr>
                            </thead>
                            <tbody>
                                {activeReferred.map((r) => (
                                    <tr key={r.address} className="border-t border-arc-border/60">
                                        <td className="py-2 pr-3 text-arc-text">{formatAddress(r.address)}</td>
                                        <td className="py-2 pr-3 text-right text-arc-text-muted">
                                            {fmtUsd(r.volumeUsdMicros)}
                                        </td>
                                        <td className="py-2 pr-3 text-right text-arc-text-muted">{r.txCount}</td>
                                        <td className="py-2 text-right font-medium text-arc-text">
                                            {fmtUsd(r.earnedUsdMicros)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
    return (
        <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-4">
            <div className="text-xs uppercase tracking-wider text-arc-text-muted">{label}</div>
            <div className={`mt-1 text-xl font-semibold ${className ?? "text-arc-text"}`}>{value}</div>
        </div>
    );
}
