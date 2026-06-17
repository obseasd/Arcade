"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ExternalLink, Info, Loader2 } from "lucide-react";
import { baseSepolia, arbitrumSepolia, sepolia } from "wagmi/chains";
import { useAccount, useSwitchChain } from "wagmi";
import { AppKit, UnifiedBalanceChain } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { pushToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Gateway / Unified Balance bridge surface.
 *
 * Wires Circle App Kit's UnifiedBalance namespace to the connected
 * wagmi wallet. Users deposit USDC on any supported source chain and
 * the credited balance becomes spendable on Arc Testnet without a
 * separate claim step.
 *
 * Path split vs the CCTP V2 toggle next door:
 *   - CCTP V2 (live): burn-mint with a 30s attestation round-trip.
 *   - Gateway (this panel): Circle backend tracks a chain-agnostic
 *     ledger; one sig on the source chain, balance available on Arc
 *     within ~10-30s, optional spend() to settle on any destination.
 *
 * Surface still preview-grade — Arc App Kit ships supported chains
 * for testnet but the exact mainnet chain set is in flux. Test on
 * Base_Sepolia first since Circle's faucet (faucet.circle.com) is the
 * most reliable place to get testnet USDC.
 */

/** Supported source chains for testnet deposits. We only expose ones
 *  where the user can plausibly obtain testnet USDC + ETH for gas. The
 *  destination is always Arc Testnet (user is on the Arcade Bridge UI). */
const TESTNET_SOURCES: {
    id: UnifiedBalanceChain;
    label: string;
    chainId: number;
    faucet: string;
}[] = [
    {
        id: UnifiedBalanceChain.Base_Sepolia,
        label: "Base Sepolia",
        chainId: baseSepolia.id,
        faucet: "https://faucet.circle.com",
    },
    {
        id: UnifiedBalanceChain.Arbitrum_Sepolia,
        label: "Arbitrum Sepolia",
        chainId: arbitrumSepolia.id,
        faucet: "https://faucet.circle.com",
    },
    {
        id: UnifiedBalanceChain.Ethereum_Sepolia,
        label: "Ethereum Sepolia",
        chainId: sepolia.id,
        faucet: "https://faucet.circle.com",
    },
];

interface GatewayBalance {
    confirmed: string;
    pending: string;
    raw?: unknown;
}

export function GatewayBridgePanel() {
    const { address: account, chainId: walletChainId, connector } = useAccount();
    const { switchChainAsync } = useSwitchChain();

    const [sourceChain, setSourceChain] = useState<UnifiedBalanceChain>(
        UnifiedBalanceChain.Base_Sepolia,
    );
    const [amount, setAmount] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [balance, setBalance] = useState<GatewayBalance | null>(null);
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [lastDepositTx, setLastDepositTx] = useState<string | null>(null);

    // Lazy-instantiate the AppKit; SDK is heavy and only needed when
    // the user actually opens the Gateway tab.
    const kit = useMemo(() => new AppKit(), []);

    const refreshBalance = useCallback(async () => {
        if (!account) {
            setBalance(null);
            return;
        }
        setBalanceLoading(true);
        try {
            // App Kit's UnifiedBalance.getBalances returns aggregated
            // confirmed + pending across every Gateway-supported chain.
            // We render the confirmed/pending split because the
            // Unified Balance Kit spec (and our project memory) flags
            // collapsing them into one number as a UX trap.
            const result = (await kit.unifiedBalance.getBalances({
                token: "USDC",
                sources: { account } as never,
                includePending: true,
            } as never)) as unknown as {
                totalConfirmedBalance?: string;
                totalPendingBalance?: string;
            };
            setBalance({
                confirmed: result?.totalConfirmedBalance ?? "0",
                pending: result?.totalPendingBalance ?? "0",
                raw: result,
            });
        } catch (err) {
            // Most failure paths here are "user doesn't have a Gateway
            // balance yet" — silently fall through rather than surface
            // a scary error toast.
            // eslint-disable-next-line no-console
            console.warn("[gateway] getBalances failed", err);
            setBalance({ confirmed: "0", pending: "0" });
        } finally {
            setBalanceLoading(false);
        }
    }, [account, kit]);

    useEffect(() => {
        void refreshBalance();
    }, [refreshBalance]);

    const canDeposit =
        !!account &&
        !!connector &&
        amount.trim() !== "" &&
        Number(amount) > 0 &&
        !submitting;

    const onDeposit = useCallback(async () => {
        if (!canDeposit || !account || !connector) return;
        setSubmitting(true);
        setLastDepositTx(null);
        try {
            const source = TESTNET_SOURCES.find((s) => s.id === sourceChain);
            if (!source) throw new Error("Unsupported source chain");
            if (walletChainId !== source.chainId) {
                pushToast({
                    kind: "info",
                    title: "Switching network",
                    message: `Switch your wallet to ${source.label} to fund the deposit.`,
                });
                await switchChainAsync({ chainId: source.chainId });
                // Some wallets (Rabby, mobile) propagate the chain
                // change asynchronously. Give the connector a beat to
                // emit chainChanged before we pull a fresh provider,
                // otherwise getProvider() may still report the old
                // chain and the SDK's balance check hits the wrong
                // USDC contract.
                await new Promise((r) => setTimeout(r, 600));
            }

            // 2026-06-17 fix: previous version passed
            // wagmi's `connectorClient.transport` (a viem Transport
            // wrapper) to createViemAdapterFromProvider. The adapter
            // expects a raw EIP-1193 provider with `.request({method,
            // params})`. The mismatch made the SDK fall back to its
            // own RPC, see balance 0, and revert with "Insufficient
            // USDC balance on <source>" even when the wallet had USDC.
            // Pull the underlying EIP-1193 provider straight off the
            // wagmi connector instead.
            const rawProvider = (await connector.getProvider()) as {
                request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
            };

            const adapter = await createViemAdapterFromProvider({
                provider: rawProvider as never,
                chain: sourceChain,
            } as never);

            // 2026-06-17: App Kit signs the source-chain approval +
            // deposit internally. The user sees ONE wallet prompt; the
            // SDK orchestrates the rest. Balance becomes available on
            // Arc once Circle's backend recognises the deposit (~10-30s).
            const result = (await kit.unifiedBalance.deposit({
                from: { adapter, chain: sourceChain },
                amount,
                token: "USDC",
            } as never)) as unknown as { transactionHash?: string };
            setLastDepositTx(result?.transactionHash ?? null);
            pushToast({
                kind: "info",
                title: "Deposit submitted",
                message: `${amount} USDC bridging in from ${labelFor(sourceChain)}. Balance updates shortly.`,
            });
            // Refresh balance soon after — Circle's backend usually
            // recognises the deposit inside the 30s window.
            setTimeout(() => void refreshBalance(), 5_000);
            setAmount("");
        } catch (err) {
            const message =
                (err as { shortMessage?: string; message?: string })
                    ?.shortMessage ??
                (err as { message?: string })?.message ??
                "Deposit failed";
            pushToast({
                kind: "error",
                title: "Gateway deposit failed",
                message: message.slice(0, 200),
            });
        } finally {
            setSubmitting(false);
        }
    }, [
        canDeposit,
        account,
        connector,
        sourceChain,
        amount,
        kit,
        refreshBalance,
        walletChainId,
        switchChainAsync,
    ]);

    return (
        <div className="arc-card space-y-4 p-5">
            {/* Balance summary header (Unified Balance pattern) */}
            <div className="rounded-xl border border-arc-border bg-white/[0.015] p-4">
                <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">
                    Your unified USDC balance
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-3">
                    <div className="font-display text-3xl font-semibold tabular-nums text-arc-text">
                        {balanceLoading ? (
                            <Loader2 className="h-5 w-5 animate-spin text-arc-text-faint" />
                        ) : (
                            <>
                                {balance?.confirmed ?? "0"}
                                <span className="ml-1 text-sm font-normal text-arc-text-muted">USDC</span>
                            </>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => void refreshBalance()}
                        className="text-[11px] text-arc-text-faint hover:text-arc-text-muted"
                    >
                        Refresh
                    </button>
                </div>
                {balance && Number(balance.pending) > 0 && (
                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-arc-border/40 pt-2 text-[11px] text-arc-text-muted">
                        <span className="uppercase tracking-wider text-arc-text-faint">Pending</span>
                        <span className="tabular-nums">{balance.pending} USDC</span>
                    </div>
                )}
            </div>

            {/* Deposit form */}
            <div className="space-y-3 rounded-xl border border-arc-border bg-white/[0.015] p-4">
                <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">
                    Deposit from
                </div>
                <div className="grid grid-cols-3 gap-2">
                    {TESTNET_SOURCES.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => setSourceChain(s.id)}
                            className={cn(
                                "rounded-lg border px-2 py-2 text-xs font-semibold transition-colors",
                                sourceChain === s.id
                                    ? "border-arc-cta-hover bg-arc-cta-hover/10 text-arc-cta-hover"
                                    : "border-arc-border bg-white/[0.015] text-arc-text-muted hover:bg-white/[0.04]",
                            )}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-arc-border bg-black/30 px-3 py-2.5">
                    <TokenIcon symbol="USDC" size={20} />
                    <input
                        type="text"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.0"
                        className="flex-1 bg-transparent text-base font-semibold tabular-nums text-arc-text outline-none placeholder:text-arc-text-faint"
                    />
                    <span className="text-xs text-arc-text-muted">USDC</span>
                </div>
                <div className="flex items-center justify-center text-arc-text-muted">
                    <ArrowDown className="h-4 w-4" />
                </div>
                <div className="rounded-lg border border-arc-border bg-black/15 px-3 py-2 text-xs">
                    <span className="text-arc-text-muted">Available on </span>
                    <span className="font-semibold text-arc-text">Arc Testnet</span>
                    <span className="text-arc-text-muted"> in ~30s</span>
                </div>
                <button
                    type="button"
                    onClick={() => void onDeposit()}
                    disabled={!canDeposit}
                    className={cn(
                        "w-full rounded-xl py-3 text-sm font-semibold transition-colors",
                        canDeposit
                            ? "bg-arc-cta text-white hover:bg-arc-cta-hover"
                            : "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted",
                    )}
                >
                    {submitting
                        ? "Submitting…"
                        : !account
                            ? "Connect wallet"
                            : walletChainId !==
                              TESTNET_SOURCES.find((s) => s.id === sourceChain)?.chainId
                                ? `Switch to ${labelFor(sourceChain)} & Deposit`
                                : "Deposit"}
                </button>
                {lastDepositTx && (
                    <a
                        href={explorerForChain(sourceChain, lastDepositTx)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
                    >
                        View deposit tx
                        <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                )}
            </div>

            {/* Faucet hint */}
            <div className="flex items-start gap-2 rounded-xl border border-arc-warn/30 bg-arc-warn/5 p-3 text-[11px] text-arc-text-muted">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-arc-warn" />
                <span>
                    Need testnet USDC?{" "}
                    <a
                        href="https://faucet.circle.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-arc-warn underline-offset-2 hover:underline"
                    >
                        Circle faucet
                    </a>
                    {" "}gives you USDC on Base / Arb / Eth Sepolia. You'll also need a
                    bit of testnet ETH on the source chain for the deposit gas fee.
                </span>
            </div>
        </div>
    );
}

function labelFor(chain: UnifiedBalanceChain): string {
    return TESTNET_SOURCES.find((s) => s.id === chain)?.label ?? String(chain);
}

function explorerForChain(chain: UnifiedBalanceChain, hash: string): string {
    switch (chain) {
        case UnifiedBalanceChain.Base_Sepolia:
            return `https://sepolia.basescan.org/tx/${hash}`;
        case UnifiedBalanceChain.Arbitrum_Sepolia:
            return `https://sepolia.arbiscan.io/tx/${hash}`;
        case UnifiedBalanceChain.Ethereum_Sepolia:
            return `https://sepolia.etherscan.io/tx/${hash}`;
        default:
            return "#";
    }
}
