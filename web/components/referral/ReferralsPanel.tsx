"use client";

import { useCallback, useEffect, useState } from "react";
import { Address } from "viem";
import { usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import {
    buildReferralLink,
    getStoredReferrer,
    isReferralAnchored,
    markReferralAnchored,
} from "@/lib/referral";
import { registerReferrerOnChain } from "@/lib/referralOnchain";
import { arcTestnet } from "@/lib/chains";
import type { ReferralStats } from "@/lib/referralPersistence";
import { formatAddress } from "@/lib/utils";

// Format USD micros entirely in BigInt - going through Number(...)/1e6 loses
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
// volume) - a wallet that connected via the link but never swapped.

/**
 * Referrals dashboard (portfolio tab). Shows the wallet's shareable referral
 * link plus claimed / pending totals and a per-referred-wallet breakdown
 * (volume, tx count, earned). Read-only - earnings accrue server-side and a
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
    // The connected wallet's OWN lifetime Arcade volume, straight from the
    // subgraph's per-Trader running total. Shown next to the referred volume so
    // a user sees their own footprint, not only their downline's. Independent of
    // the referral DB: no signature or reveal needed.
    const [myVolumeUsdMicros, setMyVolumeUsdMicros] = useState<string | null>(null);

    useEffect(() => {
        const url = process.env.NEXT_PUBLIC_GOLDSKY_URL;
        if (!account || !url) {
            setMyVolumeUsdMicros(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        query: `{ trader(id: "${account.toLowerCase()}") { totalVolumeUsdc } }`,
                    }),
                });
                if (!res.ok) return;
                const json = (await res.json()) as {
                    data?: { trader?: { totalVolumeUsdc?: string } | null };
                };
                const v = json?.data?.trader?.totalVolumeUsdc;
                if (cancelled) return;
                // BigDecimal string ("123.456789") -> exact micros, no float math.
                const [w, f] = String(v ?? "0").split(".");
                const micros =
                    BigInt(w || "0") * 1_000_000n +
                    BigInt((f ?? "").slice(0, 6).padEnd(6, "0") || "0");
                setMyVolumeUsdMicros(micros.toString());
            } catch {
                /* subgraph unreachable -> render a dash */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [account]);

    // On-chain referral anchoring. If the connected wallet arrived through
    // someone's link (?ref=), it can sign a Memo tx to make that first-touch
    // link unforgeable on-chain (see referralOnchain.ts). This is the referred
    // user's own action - nobody can register it on their behalf.
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
        const ref = r && r.toLowerCase() !== account.toLowerCase() ? (r as Address) : null;
        setMyReferrer(ref);
        // Restore the anchored state. The Memo tx is on-chain and permanent, but
        // re-deriving it on every page load would need the multi-window getLogs
        // scan, so we remember it locally instead: without this the button reset
        // to "Confirm on-chain" after every refresh and looked like the signature
        // had not been saved. Display-only - the payout still verifies the Memo
        // attribution on-chain independently, so this flag can never move money.
        const anchored = ref ? isReferralAnchored(account, ref) : false;
        setConfirmState(anchored ? "done" : "idle");
        setConfirmMsg(
            anchored
                ? "Referral anchored on-chain - your referrer is now payable and it can no longer be overwritten."
                : null,
        );
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
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            // waitForTransactionReceipt RESOLVES on a reverted tx (it does not
            // throw), so without this check a revert was silently marked
            // "anchored" and the user was told their referrer was payable when
            // no Memo had been emitted. The Memo wraps Arc's callFrom precompile,
            // which is intermittently unavailable, so a revert here is a real and
            // observed outcome, not a corner case.
            if (receipt.status !== "success") {
                setConfirmState("idle");
                setConfirmMsg(
                    "The confirmation transaction reverted on-chain (Arc's Memo precompile can be temporarily unavailable). Nothing was recorded - please try again in a moment.",
                );
                return;
            }
            // Persist so a refresh still shows it as confirmed (see the mount
            // effect above); the tx itself is the authoritative record.
            markReferralAnchored(account, myReferrer);
            setConfirmState("done");
            setConfirmMsg(
                "Referral anchored on-chain - your referrer is now payable and it can no longer be overwritten.",
            );
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
        const load = async () => {
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
                // Never let a background poll clobber the richer REVEALED stats
                // (the coarse GET withholds the per-wallet detail + claimable).
                if (!cancelled) setStats((prev) => (prev && !prev.detailWithheld ? prev : data));
            } catch {
                /* soft-fail */
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        // Refresh in the background: referred wallets + their volume used to move
        // only on a manual page reload.
        const t = setInterval(() => void load(), 30_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [account]);

    // Show EVERY referred wallet, traded or not. This used to filter on a
    // minimum volume, which meant a wallet that had joined but not yet traded
    // was invisible with no explanation -- reported live as "I referred this
    // address and it never appears". Worse, the volume column is the PAYABLE
    // figure (Arcade-pool trades since the referral), so a wallet whose trading
    // happened elsewhere or before the referral legitimately reads 0 and would
    // vanish. The funnel is the point of this table: joined, confirmed, traded.
    const visibleReferred = [...(stats?.referred ?? [])].sort((a, b) => {
        const av = BigInt(a.volumeUsdMicros || "0");
        const bv = BigInt(b.volumeUsdMicros || "0");
        if (av === bv) return a.verified === b.verified ? 0 : a.verified ? -1 : 1;
        return bv > av ? 1 : -1;
    });
    const confirmedCount = visibleReferred.filter((r) => r.verified).length;
    // referredCount counts PROVEN rows only, so a referrer whose downline never
    // signed would otherwise see a bare "0" with no way to tell "nobody joined"
    // apart from "they joined but haven't proven it". The reveal gate and the
    // empty state key off the total; the money numbers never do.
    const knownCount = (stats?.referredCount ?? 0) + (stats?.unverifiedCount ?? 0);
    // Only the on-chain-verified amount can actually be claimed, so the Claim
    // button stays disabled until that number is both known (revealed) and > 0.
    const hasClaimable = (() => {
        const raw = stats?.claimableUsdMicros;
        if (raw == null) return false;
        try {
            return BigInt(raw) > 0n;
        } catch {
            return false;
        }
    })();
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
            // The route has required { referrer, deadline, signature } since the
            // 2026-07-02 fee audit (so nobody can trigger someone else's
            // payout), but this button only ever sent { referrer } -- a
            // guaranteed 400. It is invisible today because payouts are
            // kill-switched off and the enabled:false branch answers first, so
            // the Claim button would have broken on the DAY it was turned on at
            // mainnet, with no test covering it. Same Claim signature the reveal
            // already uses.
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
            const res = await fetch("/api/referral/claim", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    referrer: account,
                    deadline: deadline.toString(),
                    signature,
                }),
            });
            const data = await res.json();
            if (data.enabled === false) {
                setClaimMsg("Payouts open at mainnet - earnings are still being verified on-chain.");
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
    }, [account, signTypedDataAsync]);

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

            {/* Your referrer - anchor first-touch on-chain (unforgeable). Once
                anchored there is nothing left to do, so collapse to a plain
                statement instead of keeping a dead button + explainer around. */}
            {myReferrer && (
                <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5">
                    <div className="text-sm font-semibold text-arc-text">Your referrer</div>
                    {confirmState === "done" ? (
                        <p className="mt-1 text-xs text-arc-text-muted">
                            Your referrer is{" "}
                            <span className="text-arc-text">{formatAddress(myReferrer)}</span>.
                        </p>
                    ) : (
                        <>
                            <p className="mt-1 text-xs text-arc-text-muted">
                                Sign to confirm{" "}
                                <span className="text-arc-text">{formatAddress(myReferrer)}</span>{" "}
                                is your referrer.
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
                                        : "Confirm on-chain"}
                                </button>
                                {confirmMsg && (
                                    <span className="text-xs text-arc-text-muted">{confirmMsg}</span>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Totals.
                CLAIMABLE is the real, claim-backing number: verified from
                on-chain confirmations by the same path the Claim button pays
                from (audit C-1). It is only known after the signed reveal, since
                computing it scans the chain -- until then we show "-" rather
                than a DB estimate dressed up as money.
                ESTIMATED is the DB accrual on reported trades. It is NOT what a
                claim pays and is labelled as an estimate so the two can never be
                confused. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Claimed" value={fmtUsd(stats?.totalClaimedUsdMicros ?? "0")} className="text-arc-success" />
                <Stat
                    label="Claimable"
                    value={
                        stats?.claimableUsdMicros != null
                            ? fmtUsd(stats.claimableUsdMicros)
                            : "-"
                    }
                    className="text-arc-warn"
                    hint={
                        stats?.claimableUsdMicros != null
                            ? undefined
                            : "reveal below to compute your verified amount"
                    }
                />
                <Stat
                    label="My volume"
                    value={myVolumeUsdMicros != null ? fmtUsd(myVolumeUsdMicros) : "-"}
                    hint="your own trading volume on Arcade"
                />
                <Stat label="Referred volume" value={fmtUsd(stats?.totalVolumeUsdMicros ?? "0")} />
            </div>
            {/* Claim. The button is only live when there is a REAL verified
                amount to claim (the on-chain-verified figure revealed below);
                otherwise it stays disabled so it never invites a no-op click. */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-arc-border bg-white/[0.015] px-5 py-4">
                <div className="text-xs text-arc-text-muted">
                    {claimMsg ?? "Earnings become claimable once verified on-chain."}
                </div>
                <button
                    type="button"
                    onClick={onClaim}
                    disabled={claiming || !hasClaimable}
                    className="arc-button-primary shrink-0 px-4 py-2 text-sm disabled:opacity-50"
                >
                    {claiming ? "Claiming…" : "Claim"}
                </button>
            </div>

            {/* Per-referred table */}
            <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5">
                <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-semibold text-arc-text">
                        {/* joined = first-touch rows in the DB. confirmed = the
                            wallet itself signed the on-chain Memo, which is the ONLY
                            tier that can ever pay. Both are shown because a downline
                            that is large but unconfirmed earns exactly nothing, and
                            that has to be visible rather than inferred from a $0. */}
                        Referred wallets{" "}
                        {stats
                            ? stats.detailWithheld && !revealed
                                ? `(${knownCount} joined)`
                                : `(${knownCount} joined, ${confirmedCount} confirmed on-chain)`
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
                                    details and compute your verified on-chain claimable -
                                    only you can view your own downline.
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
                ) : visibleReferred.length === 0 ? (
                    <div className="py-6 text-center text-sm text-arc-text-muted">
                        Nobody has joined through your link yet. Share it to start earning.
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
                                {visibleReferred.map((r) => (
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

function Stat({
    label,
    value,
    className,
    hint,
}: {
    label: string;
    value: string;
    className?: string;
    hint?: string;
}) {
    return (
        <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-4">
            <div className="text-xs uppercase tracking-wider text-arc-text-muted">{label}</div>
            <div className={`mt-1 text-xl font-semibold ${className ?? "text-arc-text"}`}>{value}</div>
            {hint && <div className="mt-1 text-[11px] leading-tight text-arc-text-muted">{hint}</div>}
        </div>
    );
}
