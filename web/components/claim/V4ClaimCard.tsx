"use client";

import { useState } from "react";
import { Address, formatUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { TWITTER_ESCROW_V4_ABI } from "@/lib/abis/twitterEscrowV4";
import { cn } from "@/lib/utils";

/** The V4 claim payload handed over from the OAuth callback (escrowVersion:"v4"). */
export interface V4ClaimCardPayload {
    escrowVersion: "v4";
    token: Address;
    positionId: string;
    slotIndex: number;
    recipient: Address;
    escrowToken: Address;
    escrowAddress: Address;
    amount: string;
    deadline: string;
    nonce: `0x${string}`;
    sig: `0x${string}`;
    handle: string;
}

/**
 * V4-hook fee claim. Two on-chain steps against ArcadeTwitterEscrowV4:
 *   1) authorize(positionId, slotIndex, recipient, token, amount, deadline, nonce, sig)
 *   2) claimByTwitter(nonce) once the timelock elapses (0 on testnet -> immediate).
 * The connected wallet MUST equal `recipient` (the escrow enforces this on-chain).
 * Isolated from the intricate V3 claim flow so that path stays untouched.
 */
export function V4ClaimCard({
    payload,
    account,
}: {
    payload: V4ClaimCardPayload;
    account: Address | null;
}) {
    const { isConnected } = useAccount();
    const publicClient = usePublicClient();
    const { writeContractAsync } = useWriteContract();
    // Escrow comes from the payload (resolved from the hook on the server), NOT
    // ADDRESSES.twitterEscrow, which breaks when the env is unset/wrong.
    const escrow = payload.escrowAddress;

    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [authorizedAt, setAuthorizedAt] = useState<number | null>(null);

    const positionId = BigInt(payload.positionId);
    const slot = BigInt(payload.slotIndex);
    const amount = BigInt(payload.amount);
    const deadline = BigInt(payload.deadline);

    // Live slot balance (claimByTwitter sweeps this, not the signed amount).
    const balQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V4_ABI,
        functionName: "balances",
        args: [positionId, slot, payload.escrowToken],
        query: { refetchInterval: 15_000 },
    });
    const liveBal = (balQ.data as bigint | undefined) ?? amount;
    const tlQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V4_ABI,
        functionName: "claimTimelock",
    });
    const timelock = Number((tlQ.data as bigint | undefined) ?? 0n);

    const recipientMismatch =
        !!account && account.toLowerCase() !== payload.recipient.toLowerCase();
    const nothingToClaim = liveBal === 0n;

    async function onClaim() {
        if (!publicClient || !account) return;
        setBusy(true);
        setMsg(null);
        try {
            // Step 1: authorize (commits the signed claim on-chain).
            const aHash = await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V4_ABI,
                functionName: "authorize",
                args: [positionId, slot, payload.recipient, payload.escrowToken, amount, deadline, payload.nonce, payload.sig],
            });
            await publicClient.waitForTransactionReceipt({ hash: aHash });
            setAuthorizedAt(Math.floor(Date.now() / 1000));

            if (timelock > 0) {
                setMsg(`Authorized. Come back in ~${Math.ceil(timelock / 60)} min to finish the claim.`);
                setBusy(false);
                return;
            }
            // Step 2 (timelock 0): sweep immediately.
            const cHash = await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V4_ABI,
                functionName: "claimByTwitter",
                args: [payload.nonce],
            });
            await publicClient.waitForTransactionReceipt({ hash: cHash });
            setDone(true);
            setMsg("Claimed. The USDC is in your wallet.");
        } catch (e) {
            setMsg(e instanceof Error ? e.message.slice(0, 200) : "Claim failed");
        } finally {
            setBusy(false);
        }
    }

    async function onFinish() {
        if (!publicClient) return;
        setBusy(true);
        setMsg(null);
        try {
            const cHash = await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V4_ABI,
                functionName: "claimByTwitter",
                args: [payload.nonce],
            });
            await publicClient.waitForTransactionReceipt({ hash: cHash });
            setDone(true);
            setMsg("Claimed. The USDC is in your wallet.");
        } catch (e) {
            setMsg(e instanceof Error ? e.message.slice(0, 200) : "Claim failed");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="mx-auto max-w-md px-4 py-12 sm:px-6">
            <div className="arc-card p-6">
                <div className="text-xs uppercase tracking-wider text-arc-text-muted">
                    Claim creator fees
                </div>
                <div className="mt-2 text-3xl font-semibold tabular-nums">
                    ${Number(formatUnits(liveBal, USDC_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
                <div className="mt-1 text-sm text-arc-text-muted">
                    Verified as <span className="text-arc-text">@{payload.handle}</span>
                    {payload.slotIndex === 1 ? " · reply-to-launch share" : ""}
                </div>

                {done ? (
                    <div className="mt-5 rounded-xl bg-arc-success/10 p-3 text-sm text-arc-success">
                        {msg}
                    </div>
                ) : !isConnected || !account ? (
                    <div className="mt-5 text-sm text-arc-text-muted">Connect your wallet to claim.</div>
                ) : recipientMismatch ? (
                    <div className="mt-5 rounded-xl bg-arc-warn/10 p-3 text-sm text-arc-warn">
                        Connect the wallet you started the claim with
                        ({payload.recipient.slice(0, 6)}…{payload.recipient.slice(-4)}).
                    </div>
                ) : nothingToClaim ? (
                    <div className="mt-5 text-sm text-arc-text-muted">
                        Nothing to claim yet. Fees accrue as your token trades, so check back later.
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={authorizedAt && timelock > 0 ? onFinish : onClaim}
                        disabled={busy}
                        className={cn(
                            "mt-5 w-full rounded-xl bg-arc-cta px-4 py-3 text-sm font-semibold text-arc-bg transition-colors hover:bg-arc-cta-hover",
                            busy && "opacity-60",
                        )}
                    >
                        {busy ? "Submitting…" : authorizedAt && timelock > 0 ? "Finish claim" : "Claim"}
                    </button>
                )}

                {msg && !done && (
                    <div className="mt-3 text-xs text-arc-text-faint break-words">{msg}</div>
                )}
            </div>
        </div>
    );
}
