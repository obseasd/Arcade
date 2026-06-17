"use client";

import { useEffect, useState } from "react";
import { erc20Abi } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import {
    BRIDGE_HISTORY_CHANGE_EVENT,
    loadBridgeHistory,
} from "@/lib/bridgeHistory";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { formatUSDC } from "@/lib/utils";

/**
 * Summary header for the Bridge page that splits the user's USDC by
 * where it currently sits:
 *
 *   - **Available** — USDC sitting in the connected wallet on Arc.
 *     Already usable in-app (swap, buy, deposit, etc.).
 *   - **Pending** — USDC bridges Circle has attested but the user
 *     hasn't claimed yet on Arc. One-click claim from the history
 *     row below mints it.
 *   - **In motion** — USDC bridges in the burn → attestation pipe.
 *     Circle still needs to attest; nothing for the user to do but
 *     wait (per-chain ETA in the active bridge card).
 *
 * Data sources are all client-side: ERC20.balanceOf for the wallet
 * leg, localStorage bridgeHistory + pendingBridge for the in-flight
 * legs. The panel auto-refreshes on the same BRIDGE_HISTORY_CHANGE_EVENT
 * the history list listens to, so a successful claim from below
 * shrinks Pending → Available without a page refresh.
 */
const ARC_CHAIN_ID = 5_042_002;

export function BridgeBalancePanel() {
    const { address: account } = useAccount();
    const usdc = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        chainId: ARC_CHAIN_ID,
        query: { enabled: !!account, refetchInterval: 15_000 },
    });
    const [pending, setPending] = useState(0n);
    const [inMotion, setInMotion] = useState(0n);

    useEffect(() => {
        if (!account) {
            setPending(0n);
            setInMotion(0n);
            return;
        }
        const recompute = () => {
            let claimable = 0n;
            let moving = 0n;
            // Iterate the persisted history: rows still in "pending"
            // status are either attested (claimable) or still waiting
            // on Circle's attestation (in motion). Minted/failed rows
            // don't represent live USDC anywhere. The active burn is
            // already written to history once it confirms, so we
            // don't also pull from pendingBridge (would double-count).
            for (const e of loadBridgeHistory(account)) {
                if (e.status !== "pending") continue;
                if (e.dstChainId !== ARC_CHAIN_ID) continue;
                const raw = BigInt(e.amountRaw6 || "0");
                if (e.attestationReady) claimable += raw;
                else moving += raw;
            }
            setPending(claimable);
            setInMotion(moving);
        };
        recompute();
        const onChange = () => recompute();
        window.addEventListener(BRIDGE_HISTORY_CHANGE_EVENT, onChange);
        const id = window.setInterval(recompute, 30_000);
        return () => {
            window.removeEventListener(BRIDGE_HISTORY_CHANGE_EVENT, onChange);
            window.clearInterval(id);
        };
    }, [account]);

    if (!account) return null;

    const available = (usdc.data as bigint | undefined) ?? 0n;
    // Hide the whole strip if nothing's in motion AND nothing's
    // claimable AND the wallet's empty — saves the new user from
    // staring at three zeroes the first time they hit the page.
    if (available === 0n && pending === 0n && inMotion === 0n) return null;

    return (
        <div className="mb-3 grid grid-cols-3 gap-2">
            <Bucket
                label="Available"
                hint="In your wallet on Arc"
                amount={available}
                tone="ok"
            />
            <Bucket
                label="Pending"
                hint={pending > 0n ? "Click claim below" : "Nothing to claim"}
                amount={pending}
                tone="warn"
            />
            <Bucket
                label="In motion"
                hint={inMotion > 0n ? "Circle attesting" : "Nothing in motion"}
                amount={inMotion}
                tone="muted"
            />
        </div>
    );
}

function Bucket({
    label,
    hint,
    amount,
    tone,
}: {
    label: string;
    hint: string;
    amount: bigint;
    tone: "ok" | "warn" | "muted";
}) {
    const labelColor =
        tone === "ok"
            ? "text-arc-text-muted"
            : tone === "warn"
                ? "text-arc-warn"
                : "text-arc-text-faint";
    return (
        <div className="rounded-xl border border-arc-border bg-arc-surface/40 p-3">
            <div className={`text-[10px] uppercase tracking-wider ${labelColor}`}>
                {label}
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
                <TokenIcon symbol="USDC" size={14} />
                <span className="font-display text-sm font-semibold tabular-nums text-arc-text">
                    {formatUSDC(amount, USDC_DECIMALS, 2)}
                </span>
            </div>
            <div className="mt-0.5 truncate text-[10px] text-arc-text-faint">
                {hint}
            </div>
        </div>
    );
}
