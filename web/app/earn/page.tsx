"use client";

import { ExternalLink, ShieldAlert, Sparkles } from "lucide-react";
import { useState } from "react";
import { erc20Abi, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import {
    USYC_ABI,
    USYC_ADDRESS,
    USYC_HASHNOTE_PRODUCT_URL,
    USYC_TELLER_ABI,
    USYC_TELLER_ADDRESS,
} from "@/lib/abis/usyc";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { cn, formatUSDC } from "@/lib/utils";

/**
 * /earn - discovery page for yield products on Arc Testnet.
 *
 * Surfaces USYC (Hashnote tokenized US T-Bills) with an in-app deposit /
 * redeem flow through the Hashnote Teller (USDC <-> USYC). The Teller is
 * entitlement-gated (KYC): a non-whitelisted wallet reverts, which the form
 * catches and explains. Balance reads are fully public.
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

    const refreshBalances = () => {
        void usdc.refetch();
        void usyc.refetch();
    };

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

                {/* Balance row: your USDC vs your USYC. Connected only. */}
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

                {/* Deposit / redeem via the Hashnote Teller. */}
                <UsycActions
                    usdcBal={usdcBal}
                    usycBal={usycBal}
                    onDone={refreshBalances}
                />

                {/* Entitlement note + links. */}
                <div className="flex items-start gap-3 border-t border-arc-border/40 bg-arc-warn/5 p-4 text-xs text-arc-text-muted">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-arc-warn" />
                    <div className="space-y-2">
                        <div>
                            <span className="font-semibold text-arc-text">
                                Entitlement-gated.
                            </span>{" "}
                            Deposit and redeem go through Hashnote&apos;s Teller
                            contract, gated by a per-wallet entitlement (KYC). A
                            wallet that isn&apos;t whitelisted will revert. Apply
                            with Hashnote / Circle to get entitled.
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
                                href={`https://testnet.arcscan.app/address/${USYC_TELLER_ADDRESS}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-arc-text-muted underline-offset-2 hover:text-arc-text"
                            >
                                Teller on Arcscan
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Deposit (USDC -> USYC via Teller.buy) / redeem (USYC -> USDC via
 *  Teller.sell). Approves the input token to the Teller first. */
function UsycActions({
    usdcBal,
    usycBal,
    onDone,
}: {
    usdcBal: bigint;
    usycBal: bigint;
    onDone: () => void;
}) {
    const { address: account } = useAccount();
    const publicClient = usePublicClient();
    const { writeContractAsync } = useWriteContract();
    const { ensureAllowance: approveUsdc } = useApproveIfNeeded(
        ADDRESSES.usdc,
        USYC_TELLER_ADDRESS,
    );
    const { ensureAllowance: approveUsyc } = useApproveIfNeeded(
        USYC_ADDRESS,
        USYC_TELLER_ADDRESS,
    );

    const [mode, setMode] = useState<"deposit" | "redeem">("deposit");
    const [amount, setAmount] = useState("");
    const [busy, setBusy] = useState(false);

    const isDeposit = mode === "deposit";
    const inBal = isDeposit ? usdcBal : usycBal;
    const inSym = isDeposit ? "USDC" : "USYC";
    const outSym = isDeposit ? "USYC" : "USDC";

    let amountRaw = 0n;
    try {
        amountRaw = amount ? parseUnits(amount, 6) : 0n;
    } catch {
        amountRaw = 0n;
    }
    const overBalance = amountRaw > inBal;
    const canSubmit = !!account && amountRaw > 0n && !overBalance && !busy;

    const onSubmit = async () => {
        if (!account || !publicClient || amountRaw <= 0n) return;
        setBusy(true);
        try {
            if (isDeposit) {
                await approveUsdc(amountRaw);
                const hash = await writeContractAsync({
                    address: USYC_TELLER_ADDRESS,
                    abi: USYC_TELLER_ABI,
                    functionName: "buy",
                    args: [amountRaw],
                });
                const r = await publicClient.waitForTransactionReceipt({ hash });
                if (r.status !== "success") throw new Error("reverted");
            } else {
                await approveUsyc(amountRaw);
                const hash = await writeContractAsync({
                    address: USYC_TELLER_ADDRESS,
                    abi: USYC_TELLER_ABI,
                    functionName: "sell",
                    args: [amountRaw],
                });
                const r = await publicClient.waitForTransactionReceipt({ hash });
                if (r.status !== "success") throw new Error("reverted");
            }
            pushToast({
                kind: "info",
                title: isDeposit ? "Deposited into USYC" : "Redeemed to USDC",
                message: `${amount} ${inSym} converted to ${outSym}.`,
            });
            setAmount("");
            onDone();
        } catch (e) {
            const raw = e instanceof Error ? e.message : "Transaction failed";
            // The most common failure is a non-entitled wallet (the Teller
            // reverts). Surface that plainly instead of a raw revert dump.
            const entitlement = /revert|entitl|not.*(allow|whitelist)|execution/i.test(raw);
            pushToast({
                kind: "error",
                title: isDeposit ? "Deposit failed" : "Redeem failed",
                message: entitlement
                    ? "The Teller reverted. This wallet may not be entitled (whitelisted) for USYC yet, or the amount is out of range. Confirm the wallet is whitelisted with Hashnote / Circle."
                    : raw.slice(0, 160),
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="border-t border-arc-border/40 p-4">
            {/* Mode tabs */}
            <div className="mb-3 inline-flex rounded-xl border border-arc-border bg-black/20 p-0.5 text-xs">
                {(["deposit", "redeem"] as const).map((m) => (
                    <button
                        key={m}
                        type="button"
                        onClick={() => {
                            setMode(m);
                            setAmount("");
                        }}
                        className={cn(
                            "rounded-lg px-3 py-1.5 font-medium transition-colors",
                            mode === m
                                ? "bg-arc-cta-hover text-white"
                                : "text-arc-text-muted hover:text-arc-text",
                        )}
                    >
                        {m === "deposit" ? "Deposit (USDC to USYC)" : "Redeem (USYC to USDC)"}
                    </button>
                ))}
            </div>

            <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-4">
                <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-arc-text-faint">
                    <span>You pay ({inSym})</span>
                    <button
                        type="button"
                        onClick={() => setAmount(formatUSDC(inBal, USDC_DECIMALS, 6))}
                        className="rounded-md bg-arc-surface-2 px-1.5 py-0.5 font-semibold text-arc-text hover:bg-arc-surface-3"
                    >
                        MAX
                    </button>
                </div>
                <div className="flex items-center gap-2">
                    <TokenIcon symbol={inSym} size={20} />
                    <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.0"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                        className="w-full bg-transparent text-2xl font-semibold tabular-nums text-arc-text outline-none placeholder:text-arc-text-faint"
                    />
                </div>
                <div className="mt-1 text-[11px] text-arc-text-muted">
                    Balance: {formatUSDC(inBal, USDC_DECIMALS, 2)} {inSym}. You
                    receive {outSym} at the Teller&apos;s oracle rate (~1:1).
                </div>
            </div>

            <button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit}
                className={cn(
                    "mt-3 w-full rounded-2xl py-3 text-sm font-semibold transition-colors",
                    canSubmit
                        ? "bg-arc-cta text-white hover:bg-arc-cta-hover"
                        : "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted",
                )}
            >
                {!account
                    ? "Connect wallet"
                    : busy
                      ? isDeposit
                          ? "Depositing…"
                          : "Redeeming…"
                      : amountRaw <= 0n
                        ? "Enter an amount"
                        : overBalance
                          ? `Insufficient ${inSym}`
                          : isDeposit
                            ? "Deposit into USYC"
                            : "Redeem to USDC"}
            </button>
        </div>
    );
}
