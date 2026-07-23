"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { useAccount } from "wagmi";
import { captureReferralFromUrl, registerStoredReferral } from "@/lib/referral";
import { formatAddress } from "@/lib/utils";

// One dismissal per referrer so the banner never nags after it's been seen.
const DISMISS_KEY = (ref: string) => `arcade.referrer.ack.dismissed.${ref.toLowerCase()}`;

/**
 * Headless component mounted once in the root layout. Captures a ?ref=
 * referrer from the URL on first paint (first-touch, stored in
 * localStorage), then registers it the moment a wallet connects. Renders
 * nothing.
 *
 * TWO TIERS, in this order and never the reverse:
 *  1. Register UNVERIFIED, immediately and unconditionally. This is the
 *     attribution safety net: it is exactly the previous behaviour and it
 *     survives a rejected popup, a wallet that cannot sign typed data, and a
 *     closed tab.
 *  2. Ask the wallet to PROVE it, once. /api/referral/register is
 *     unauthenticated and the caller names BOTH addresses, so an unsigned row
 *     is a claim anyone can make about anyone; only the referred wallet can
 *     produce this signature, so it is the only tier that is counted or paid.
 *
 * Doing (2) first would trade a real attribution for a maybe. Step 2 shipped
 * server-side with no client for a while, which left `verified` false for every
 * row in existence and the whole proven tier dead behind an impossible
 * condition -- this component is the missing half.
 */
export function ReferralCapture() {
    const { address } = useAccount();
    const pathname = usePathname();

    // Landing acknowledgement (audit U-1/U-2): a user arriving via ?ref=0x...
    // should immediately SEE they were referred and what makes it count, rather
    // than that living only in a buried dashboard tab.
    const [ackReferrer, setAckReferrer] = useState<string | null>(null);

    // Capture the referrer from the URL as early as possible (before the
    // user navigates away from the landing URL that carried ?ref=).
    useEffect(() => {
        const ref = captureReferralFromUrl();
        if (!ref) return;
        try {
            if (localStorage.getItem(DISMISS_KEY(ref)) === null) setAckReferrer(ref);
        } catch {
            /* no storage -> just don't show the banner */
        }
    }, []);

    const dismissAck = useCallback(() => {
        if (ackReferrer) {
            try {
                localStorage.setItem(DISMISS_KEY(ackReferrer), "1");
            } catch {
                /* ignore */
            }
        }
        setAckReferrer(null);
    }, [ackReferrer]);

    // Register the stored referrer once a wallet is connected. Attribution only:
    // NO signature is requested here.
    //
    // We used to also auto-prompt an EIP-712 "Register" signature on every
    // connect. It popped up unrequested on page load, re-appeared on every
    // refresh, and - worst - it did NOT make the referrer payable (only the
    // on-chain Memo confirmation does), so it taught users the wrong thing.
    // Dropped in favour of ONE explicit, meaningful confirmation: the
    // "Confirm on-chain" button on /referrals.
    useEffect(() => {
        if (!address) return;
        void registerStoredReferral(address);
    }, [address]);

    // Hide once the referrer is the connected wallet (self-referral, never
    // valid) or while already on the referrals dashboard (the CTA target).
    const showAck =
        ackReferrer !== null &&
        ackReferrer.toLowerCase() !== (address ?? "").toLowerCase() &&
        pathname !== "/referrals";

    if (!showAck) return null;

    return (
        <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md sm:inset-x-auto sm:right-4">
            <div className="flex items-start gap-3 rounded-2xl border border-arc-border bg-arc-bg-elevated/95 p-4 shadow-arc-card backdrop-blur-xl">
                <div className="min-w-0 flex-1 text-xs text-arc-text-muted">
                    <div className="text-sm font-semibold text-arc-text">You were referred</div>
                    <p className="mt-1">
                        by <span className="text-arc-text">{formatAddress(ackReferrer!)}</span>.
                        Confirm it on-chain so they can earn from your trades - one tiny
                        transaction only you can sign.
                    </p>
                    <Link
                        href="/referrals"
                        onClick={dismissAck}
                        className="arc-button-primary mt-3 inline-block px-3 py-1.5 text-xs"
                    >
                        Confirm referral
                    </Link>
                </div>
                <button
                    type="button"
                    onClick={dismissAck}
                    aria-label="Dismiss"
                    className="shrink-0 rounded-lg p-1 text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
}
