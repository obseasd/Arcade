"use client";

import { ExternalLink, ShieldAlert, Sparkles } from "lucide-react";
import { erc20Abi } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { USYC_ABI, USYC_ADDRESS, USYC_HASHNOTE_PRODUCT_URL } from "@/lib/abis/usyc";
import { formatUSDC } from "@/lib/utils";

/**
 * /earn — discovery page for yield products that live on Arc Testnet.
 *
 * Currently surfaces just USYC (Hashnote tokenized US T-Bills). Mint
 * and redeem flow through Hashnote's Teller contract and require KYC
 * (Hashnote's entitlements list), so this page intentionally STOPS at
 * "here's the product, here's your balance if any, here's the KYC
 * application link". A KYC-applied treasury wallet would unlock the
 * in-app deposit flow, but routing testnet user wallets through KYC
 * isn't realistic — keep that off-app until mainnet.
 *
 * Adding more yield products later: drop another card in the grid
 * below following the same shape (icon + headline + balance row +
 * action). The page itself stays a single client component until the
 * product set warrants splitting.
 */
export default function EarnPage() {
    const { address: account } = useAccount();

    const usdc = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account, refetchInterval: 20_000 },
    });
    const usyc = useReadContract({
        address: USYC_ADDRESS,
        abi: USYC_ABI,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account, refetchInterval: 20_000 },
    });

    const usdcBal = (usdc.data as bigint | undefined) ?? 0n;
    const usycBal = (usyc.data as bigint | undefined) ?? 0n;

    return (
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-14">
            <div className="mb-6">
                <h1 className="font-display text-2xl font-semibold text-arc-text">
                    Earn
                </h1>
                <p className="mt-1 text-sm text-arc-text-muted">
                    Yield products available on Arc Testnet. More to come.
                </p>
            </div>

            <div className="arc-card overflow-hidden">
                <div className="flex items-start gap-4 p-5">
                    <TokenIcon symbol="USYC" size={48} />
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <span className="font-display text-lg font-semibold text-arc-text">
                                USYC
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-md border border-sky-400/40 bg-sky-400/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
                                <Sparkles className="h-2.5 w-2.5" />
                                ~4-5% APR
                            </span>
                        </div>
                        <p className="mt-1 text-sm text-arc-text-muted">
                            Yield-bearing USD wrapper from Hashnote. Backed
                            by a US T-Bill basket; price accrues toward
                            the underlying yield over time. Same 6 decimals
                            as USDC so the mental model stays 1:1.
                        </p>
                    </div>
                </div>

                {/* Balance row — your USDC vs your USYC. Visible only
                  *  when the wallet is connected so disconnected first
                  *  paint is purely educational. */}
                {account && (
                    <div className="grid grid-cols-2 border-t border-arc-border/40">
                        <div className="border-r border-arc-border/40 p-4">
                            <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">
                                Your USDC
                            </div>
                            <div className="mt-1 flex items-baseline gap-1.5">
                                <TokenIcon symbol="USDC" size={14} />
                                <span className="font-display text-base font-semibold tabular-nums text-arc-text">
                                    {formatUSDC(usdcBal, USDC_DECIMALS, 2)}
                                </span>
                            </div>
                        </div>
                        <div className="p-4">
                            <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">
                                Your USYC
                            </div>
                            <div className="mt-1 flex items-baseline gap-1.5">
                                <TokenIcon symbol="USYC" size={14} />
                                <span className="font-display text-base font-semibold tabular-nums text-arc-text">
                                    {formatUSDC(usycBal, USDC_DECIMALS, 2)}
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* KYC notice + action. We intentionally don't ship a
                  *  mint button — minting through Hashnote's Teller is
                  *  gated by entitlements (KYC) that no testnet wallet
                  *  has by default. Pushing the user to apply on
                  *  Hashnote first is more honest than failing a
                  *  reverted on-chain mint. */}
                <div className="flex items-start gap-3 border-t border-arc-border/40 bg-arc-warn/5 p-4 text-xs text-arc-text-muted">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-arc-warn" />
                    <div className="space-y-2">
                        <div>
                            <span className="font-semibold text-arc-text">KYC required.</span>{" "}
                            Mint and redeem go through Hashnote's Teller
                            contract, which is gated by a per-wallet
                            entitlement. Apply on Hashnote first; then
                            the on-chain mint flow becomes available.
                        </div>
                        <div className="flex flex-wrap gap-3">
                            <a
                                href={USYC_HASHNOTE_PRODUCT_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-arc-warn underline-offset-2 hover:underline"
                            >
                                Learn more on Hashnote
                                <ExternalLink className="h-3 w-3" />
                            </a>
                            <a
                                href={`https://testnet.arcscan.app/address/${USYC_ADDRESS}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-arc-text-muted underline-offset-2 hover:text-arc-text"
                            >
                                USYC contract on Arcscan
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
