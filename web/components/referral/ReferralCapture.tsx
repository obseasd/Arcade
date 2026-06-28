"use client";

import { useEffect } from "react";
import { useAccount } from "wagmi";
import {
    captureReferralFromUrl,
    registerStoredReferral,
} from "@/lib/referral";

/**
 * Headless component mounted once in the root layout. Captures a ?ref=
 * referrer from the URL on first paint (first-touch, stored in
 * localStorage), then registers it the moment a wallet connects. Renders
 * nothing.
 */
export function ReferralCapture() {
    const { address } = useAccount();

    // Capture the referrer from the URL as early as possible (before the
    // user navigates away from the landing URL that carried ?ref=).
    useEffect(() => {
        captureReferralFromUrl();
    }, []);

    // Register the stored referrer once a wallet is connected.
    useEffect(() => {
        if (address) void registerStoredReferral(address);
    }, [address]);

    return null;
}
