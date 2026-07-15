"use client";

import { useEffect, useRef } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import {
    captureReferralFromUrl,
    registerStoredReferral,
    proveStoredReferral,
    hasSettledReferralProof,
    getStoredReferrer,
} from "@/lib/referral";

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
    const { signTypedDataAsync } = useSignTypedData();
    // Guards against React StrictMode's double-invoked effect and against a
    // re-render firing a second wallet popup for the same account.
    const askedFor = useRef<string | null>(null);

    // Capture the referrer from the URL as early as possible (before the
    // user navigates away from the landing URL that carried ?ref=).
    useEffect(() => {
        captureReferralFromUrl();
    }, []);

    // Register the stored referrer once a wallet is connected, then prove it.
    useEffect(() => {
        if (!address) return;
        let cancelled = false;
        void (async () => {
            await registerStoredReferral(address);
            if (cancelled) return;
            // Nothing to prove, or this wallet already settled (proved or
            // declined): never re-prompt.
            if (!getStoredReferrer()) return;
            if (hasSettledReferralProof(address)) return;
            if (askedFor.current === address) return;
            askedFor.current = address;
            await proveStoredReferral(address, (args) =>
                signTypedDataAsync({
                    domain: args.domain,
                    types: args.types,
                    primaryType: args.primaryType,
                    message: args.message,
                }),
            );
        })();
        return () => {
            cancelled = true;
        };
    }, [address, signTypedDataAsync]);

    return null;
}
