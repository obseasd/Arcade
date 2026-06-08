"use client";

import { CheckCircle2, Clock, Twitter } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
import { ADDRESSES } from "@/lib/constants";
import {
    PENDING_CLAIMS_CHANGE_EVENT,
    PendingTwitterClaim,
    readPendingClaim,
    removePendingClaim,
    resumeClaimUrl,
} from "@/lib/pendingClaims";

interface Props {
    token: Address;
    slotIndex: bigint;
}

/**
 * Banner shown on a token's detail page when the connected wallet has a
 * pending Twitter claim saved locally for this (token, slotIndex). The
 * pendingClaims module persists the snapshot after a successful authorize
 * tx so the user has a stable way back to /claim with the same nonce after
 * the timelock window elapses - otherwise re-OAuthing would mint a fresh
 * nonce that collides with the in-flight pending (SlotPending revert) and
 * they'd be stuck.
 *
 * Auto-hides when:
 *   - The escrow's `claimed[positionId][slotIndex]` flag is true (settled
 *     elsewhere, eg via this banner's button or via someone calling the
 *     claim from another device).
 *   - The user clicks the explicit "Dismiss" X (manual cleanup).
 *
 * Updates every second so the countdown reads right; promotes itself to
 * "Ready to claim" the moment `executeAfter` is reached.
 */
export function PendingClaimBanner({ token, slotIndex }: Props) {
    const { address: account } = useAccount();
    const [claim, setClaim] = useState<PendingTwitterClaim | undefined>(undefined);
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

    // Initial read + listen for cross-tab + same-tab updates. Use slotIndex
    // as a string so the storage keying matches what /claim wrote.
    useEffect(() => {
        if (!account) return;
        const refresh = () => setClaim(readPendingClaim(account, token, slotIndex.toString()));
        refresh();
        const onStorage = (e: StorageEvent) => {
            if (e.key && e.key.startsWith("arcade:pending-twitter-claim:")) refresh();
        };
        const onCustom = () => refresh();
        window.addEventListener("storage", onStorage);
        window.addEventListener(PENDING_CLAIMS_CHANGE_EVENT, onCustom);
        return () => {
            window.removeEventListener("storage", onStorage);
            window.removeEventListener(PENDING_CLAIMS_CHANGE_EVENT, onCustom);
        };
    }, [account, token, slotIndex]);

    // 1s tick for the countdown. Stops while there's no claim to render.
    useEffect(() => {
        if (!claim) return;
        const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(id);
    }, [claim]);

    // On-chain check: if this slot has been claimed elsewhere, clean up the
    // local entry so the banner doesn't linger.
    const claimedQ = useReadContract({
        address: ADDRESSES.twitterEscrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "claimed",
        args: claim ? [BigInt(claim.positionId), BigInt(claim.slotIndex)] : undefined,
        query: { enabled: !!claim, refetchInterval: 15_000 },
    });
    useEffect(() => {
        if (!claim || !account) return;
        if (claimedQ.data === true) {
            removePendingClaim(account, claim.token, claim.slotIndex);
            setClaim(undefined);
        }
    }, [account, claim, claimedQ.data]);

    if (!account || !claim) return null;

    const ready = now >= claim.executeAfter;
    const remaining = claim.executeAfter - now;
    const dismiss = () => {
        removePendingClaim(account, claim.token, claim.slotIndex);
        setClaim(undefined);
    };

    return (
        <div
            className={`arc-card flex items-start gap-3 p-4 ${ready ? "border-arc-success/40 bg-arc-success/5" : "border-arc-cta-hover/40 bg-arc-cta-hover/5"}`}
        >
            <div className={ready ? "text-arc-success" : "text-arc-cta-hover"}>
                {ready ? <CheckCircle2 className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                    {ready ? "Twitter claim ready" : "Twitter claim authorized"}
                    {claim.handle && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-arc-border bg-arc-surface-2 px-1.5 py-0.5 text-[10px] text-arc-text-muted">
                            <Twitter className="h-2.5 w-2.5" />@{claim.handle}
                        </span>
                    )}
                </div>
                <div className="mt-1 text-xs text-arc-text-muted">
                    {ready
                        ? "Click Finish to sweep the credited balance to your wallet."
                        : `Timelock unlocks in ${formatRemaining(remaining)}. You can leave this page; the banner stays here until you finish.`}
                </div>
                <div className="mt-3 flex items-center gap-2">
                    <Link
                        href={resumeClaimUrl(claim)}
                        className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${ready ? "bg-arc-success/20 text-arc-success hover:bg-arc-success/30" : "bg-arc-cta-hover/20 text-arc-cta-hover"}`}
                    >
                        {ready ? "Finish claim" : "View pending"}
                    </Link>
                </div>
            </div>
            <button type="button"
                onClick={dismiss}
                aria-label="Dismiss"
                className="text-arc-text-faint transition-colors hover:text-arc-text"
            >
                <CrossIcon size={16} />
            </button>
        </div>
    );
}

function formatRemaining(seconds: number): string {
    if (seconds <= 0) return "0s";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
