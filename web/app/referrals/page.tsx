"use client";

import { useAccount } from "wagmi";
import { ReferralsPanel } from "@/components/referral/ReferralsPanel";

/**
 * First-class Referrals dashboard (audit D-1). Previously the only way to reach
 * ReferralsPanel was /my-tokens?tab=referrals, with no nav entry. This route
 * gives referrals a real home and a nav link; the panel itself is unchanged.
 */
export default function ReferralsPage() {
    const { address } = useAccount();

    return (
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
            <div className="mb-6">
                <h1 className="font-display text-2xl font-semibold text-arc-text">Referrals</h1>
                <p className="mt-1 text-sm text-arc-text-muted">
                    Share your link, and earn 10% of the protocol fees the wallets you refer
                    generate. Earnings become claimable once a referral is confirmed on-chain.
                </p>
            </div>
            <ReferralsPanel account={address} />
        </div>
    );
}
