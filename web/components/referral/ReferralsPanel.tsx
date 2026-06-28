"use client";

import { useCallback, useEffect, useState } from "react";
import { Address } from "viem";
import { buildReferralLink } from "@/lib/referral";
import type { ReferralStats } from "@/lib/referralPersistence";
import { formatAddress } from "@/lib/utils";

// Format USD micros entirely in BigInt — going through Number(...)/1e6 loses
// precision (and can print Infinity) above ~$9M (audit M-5).
const fmtUsd = (micros: string) => {
    const m = BigInt(micros);
    const neg = m < 0n;
    const abs = neg ? -m : m;
    const dollars = abs / 1_000_000n;
    const cents = (abs % 1_000_000n) / 10_000n; // 2dp, truncated
    return `${neg ? "-" : ""}$${dollars.toLocaleString()}.${cents
        .toString()
        .padStart(2, "0")}`;
};

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
    const [claiming, setClaiming] = useState(false);
    const [claimMsg, setClaimMsg] = useState<string | null>(null);

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

    const onClaim = useCallback(async () => {
        if (!account) return;
        setClaiming(true);
        setClaimMsg(null);
        try {
            const res = await fetch("/api/referral/claim", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ referrer: account }),
            });
            const data = await res.json();
            if (data.enabled === false) {
                setClaimMsg("Payouts open at mainnet — earnings are still being verified on-chain.");
            } else if (data.ok && data.claimed === "0") {
                setClaimMsg("Nothing to claim yet.");
            } else if (data.ok && data.txHash) {
                setClaimMsg(`Claimed ${fmtUsd(data.claimed)} (tx ${String(data.txHash).slice(0, 10)}…)`);
            } else {
                setClaimMsg(data.error ?? "Claim unavailable.");
            }
        } catch {
            setClaimMsg("Claim failed. Try again later.");
        } finally {
            setClaiming(false);
        }
    }, [account]);

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

            {/* Claim (Phase 2 — disabled until on-chain verification is wired) */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-arc-border bg-white/[0.015] px-5 py-4">
                <div className="text-xs text-arc-text-muted">
                    {claimMsg ?? "Earnings become claimable once verified on-chain."}
                </div>
                <button
                    type="button"
                    onClick={onClaim}
                    disabled={claiming}
                    className="arc-button-primary shrink-0 px-4 py-2 text-sm disabled:opacity-50"
                >
                    {claiming ? "Claiming…" : "Claim"}
                </button>
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
