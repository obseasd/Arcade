"use client";

import { useCallback, useEffect, useState } from "react";
import { Address } from "viem";
import { usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import { buildReferralLink, getStoredReferrer } from "@/lib/referral";
import { registerReferrerOnChain } from "@/lib/referralOnchain";
import { arcTestnet } from "@/lib/chains";
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
    const [stats, setStats] = useState<
        (ReferralStats & { detailWithheld?: boolean }) | null
    >(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [claimMsg, setClaimMsg] = useState<string | null>(null);

    // On-chain referral anchoring. If the connected wallet arrived through
    // someone's link (?ref=), it can sign a Memo tx to make that first-touch
    // link unforgeable on-chain (see referralOnchain.ts). This is the referred
    // user's own action — nobody can register it on their behalf.
    const { writeContractAsync } = useWriteContract();
    const publicClient = usePublicClient();
    const [myReferrer, setMyReferrer] = useState<Address | null>(null);
    const [confirmState, setConfirmState] = useState<
        "idle" | "confirming" | "done"
    >("idle");
    const [confirmMsg, setConfirmMsg] = useState<string | null>(null);

    useEffect(() => {
        if (!account) {
            setMyReferrer(null);
            return;
        }
        const r = getStoredReferrer();
        setMyReferrer(
            r && r.toLowerCase() !== account.toLowerCase() ? (r as Address) : null,
        );
        setConfirmState("idle");
        setConfirmMsg(null);
    }, [account]);

    // Reveal the per-wallet downline. GET /stats returns coarse totals only
    // (audit 2026-07-08: the detailed graph was an unauthenticated leak); the
    // referrer signs an EIP-712 message (same gate as /claim) to prove they
    // own `account`, and POST returns their own referred wallets.
    const { signTypedDataAsync } = useSignTypedData();
    const [revealing, setRevealing] = useState(false);
    const [revealed, setRevealed] = useState(false);

    const onReveal = useCallback(async () => {
        if (!account) return;
        setRevealing(true);
        try {
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
            const signature = await signTypedDataAsync({
                domain: { name: "ArcadeReferral", version: "1", chainId: arcTestnet.id },
                types: {
                    Claim: [
                        { name: "referrer", type: "address" },
                        { name: "deadline", type: "uint256" },
                    ],
                },
                primaryType: "Claim",
                message: { referrer: account, deadline },
            });
            const res = await fetch("/api/referral/stats", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    referrer: account,
                    deadline: deadline.toString(),
                    signature,
                }),
            });
            const data = (await res.json()) as ReferralStats;
            if (res.ok) {
                setStats(data);
                setRevealed(true);
            }
        } catch {
            /* user rejected the signature or the request failed */
        } finally {
            setRevealing(false);
        }
    }, [account, signTypedDataAsync]);

    const onConfirmReferrer = useCallback(async () => {
        if (!account || !myReferrer || !publicClient) return;
        setConfirmState("confirming");
        setConfirmMsg(null);
        try {
            const hash = await registerReferrerOnChain(
                writeContractAsync,
                account,
                myReferrer,
                arcTestnet.id,
            );
            await publicClient.waitForTransactionReceipt({ hash });
            setConfirmState("done");
            setConfirmMsg("Referral anchored on-chain — it can no longer be overwritten.");
        } catch (e) {
            setConfirmState("idle");
            setConfirmMsg(
                (e as { shortMessage?: string })?.shortMessage ??
                    "Could not confirm on-chain.",
            );
        }
    }, [account, myReferrer, publicClient, writeContractAsync]);

    useEffect(() => {
        if (!account) {
            setStats(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setRevealed(false);
        (async () => {
            try {
                const res = await fetch(`/api/referral/stats?referrer=${account}`);
                const data = (await res.json()) as ReferralStats & {
                    detailWithheld?: boolean;
                    error?: string;
                };
                // A 500 returns { error }, which has none of the stats fields.
                // Storing it anyway rendered "No active referrals yet" with all
                // zeros -- an outage that reads as an empty downline, which is
                // exactly how a broken referral program stays unreported.
                if (!res.ok || data.error) throw new Error(data.error ?? "stats failed");
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
    // referredCount counts PROVEN rows only, so a referrer whose downline never
    // signed would otherwise see a bare "0" with no way to tell "nobody joined"
    // apart from "they joined but haven't proven it". The reveal gate and the
    // empty state key off the total; the money numbers never do.
    const knownCount = (stats?.referredCount ?? 0) + (stats?.unverifiedCount ?? 0);
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

            {/* Your referrer — anchor first-touch on-chain (unforgeable) */}
            {myReferrer && (
                <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5">
                    <div className="text-sm font-semibold text-arc-text">Your referrer</div>
                    <p className="mt-1 text-xs text-arc-text-muted">
                        You were referred by{" "}
                        <span className="text-arc-text">{formatAddress(myReferrer)}</span>. Anchor
                        it on-chain so the attribution is{" "}
                        <span className="text-arc-text">unforgeable</span> and ready for payouts —
                        one tiny transaction, and only you can sign it.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={onConfirmReferrer}
                            disabled={confirmState !== "idle"}
                            className="arc-button-primary shrink-0 px-4 py-2 text-sm disabled:opacity-50"
                        >
                            {confirmState === "confirming"
                                ? "Confirming…"
                                : confirmState === "done"
                                  ? "Confirmed on-chain ✓"
                                  : "Confirm on-chain"}
                        </button>
                        {confirmMsg && (
                            <span className="text-xs text-arc-text-muted">{confirmMsg}</span>
                        )}
                    </div>
                </div>
            )}

            {/* Totals. Proven attribution only — see getReferralStats. */}
            <div className="grid grid-cols-3 gap-3">
                <Stat label="Claimed" value={fmtUsd(stats?.totalClaimedUsdMicros ?? "0")} className="text-arc-success" />
                <Stat label="Pending" value={fmtUsd(stats?.totalPendingUsdMicros ?? "0")} className="text-arc-warn" />
                <Stat label="Referred volume" value={fmtUsd(stats?.totalVolumeUsdMicros ?? "0")} />
            </div>
            {(stats?.unverifiedCount ?? 0) > 0 && (
                <div className="rounded-2xl border border-arc-border bg-white/[0.015] px-5 py-3 text-xs text-arc-text-muted">
                    {stats!.unverifiedCount} referred wallet
                    {stats!.unverifiedCount > 1 ? "s have" : " has"} not confirmed the referral
                    yet, so {fmtUsd(stats!.unverifiedPendingUsdMicros)} is not counted above.
                    Confirming is free and takes one signature at connect — anyone can claim a
                    referral they didn&apos;t make, so only a confirmed one earns.
                </div>
            )}

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
                        Referred wallets{" "}
                        {stats
                            ? `(${stats.detailWithheld && !revealed ? knownCount : activeReferred.length})`
                            : ""}
                    </div>
                </div>
                {loading && !stats ? (
                    <div className="py-6 text-center text-sm text-arc-text-muted">Loading…</div>
                ) : stats?.detailWithheld && !revealed ? (
                    <div className="py-6 text-center text-sm text-arc-text-muted">
                        {knownCount > 0 ? (
                            <>
                                <div>
                                    You have {knownCount} referred wallet
                                    {knownCount > 1 ? "s" : ""}. Sign to reveal the
                                    details — only you can view your own downline.
                                </div>
                                <button
                                    type="button"
                                    onClick={onReveal}
                                    disabled={revealing}
                                    className="arc-button-primary mt-3 px-4 py-2 text-sm disabled:opacity-50"
                                >
                                    {revealing ? "Signing…" : "Reveal referred wallets"}
                                </button>
                            </>
                        ) : (
                            "No active referrals yet. Share your link to start earning."
                        )}
                    </div>
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
                                        <td className="py-2 pr-3 text-arc-text">
                                            {formatAddress(r.address)}
                                            {!r.verified && (
                                                <span
                                                    title="Unconfirmed: this wallet has not signed the referral, so it earns nothing."
                                                    className="ml-2 rounded-full border border-arc-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-arc-text-muted"
                                                >
                                                    unconfirmed
                                                </span>
                                            )}
                                        </td>
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
