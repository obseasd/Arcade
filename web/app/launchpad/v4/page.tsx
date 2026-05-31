"use client";

import { ArrowLeft, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { decodeEventLog, erc20Abi, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { V4_LAUNCHPAD_ABI } from "@/lib/abis/v4Launchpad";
import {
    ADDRESSES,
    CREATION_FEE_USDC,
    V4_ENABLED,
    V4_TICK_SPACING,
} from "@/lib/constants";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { cn, formatUSDC } from "@/lib/utils";
import { quoteInitializePool } from "@/lib/v4";
import { sqrtPriceFromFdv } from "@/lib/v4/pricing";

function sliderFill(pct: number): string {
    const p = Math.max(0, Math.min(100, pct));
    return `linear-gradient(to right, #15508f 0%, #2f7fd6 ${p}%, rgba(255,255,255,0.16) ${p}%, rgba(255,255,255,0.16) 100%)`;
}

export default function V4LaunchPage() {
    if (!V4_ENABLED) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="rounded-2xl border border-arc-border bg-arc-surface p-8 text-center">
                    <Lock className="mx-auto h-8 w-8 text-arc-text-muted" />
                    <h1 className="mt-4 text-xl font-semibold">V4 launches not enabled</h1>
                    <p className="mt-2 text-sm text-arc-text-muted">
                        Set <code>NEXT_PUBLIC_V4_ENABLED=1</code> in env to access this page.
                    </p>
                    <Link
                        href="/launchpad"
                        className="mt-6 inline-block rounded-lg border border-arc-border bg-arc-surface px-4 py-2 text-sm hover:border-arc-primary/40"
                    >
                        Back to launchpad
                    </Link>
                </div>
            </div>
        );
    }
    return <V4LaunchInner />;
}

function V4LaunchInner() {
    const router = useRouter();
    const publicClient = usePublicClient();
    const { address, isConnected } = useAccount();

    // --- Form state ---------------------------------------------------------
    const [name, setName] = useState("");
    const [symbol, setSymbol] = useState("");
    const [metadataURI, setMetadataURI] = useState("");
    const [snipeStartBps, setSnipeStartBps] = useState(500); // 5%
    const [snipeDecayMinutes, setSnipeDecayMinutes] = useState(30);
    const [creatorBps, setCreatorBps] = useState(0);
    const [targetFdvUsd, setTargetFdvUsd] = useState(100_000); // $100k

    // --- Tx state ----------------------------------------------------------
    const [createState, setCreateState] = useState<TxState>({ status: "idle" });
    const [initState, setInitState] = useState<TxState>({ status: "idle" });
    const [tokenAddr, setTokenAddr] = useState<Address | undefined>();

    const usdc = ADDRESSES.usdc;
    const launchpad = ADDRESSES.v4Launchpad;

    // Allowance for the 3 USDC creation fee.
    const { ensureAllowance } = useApproveIfNeeded(usdc, launchpad);

    const { writeContractAsync } = useWriteContract();

    // Pool allocation = TOTAL_SUPPLY - creator allocation. Used after token
    // deploy to size the liquidityDelta.
    const { data: poolAllocation } = useReadContract({
        address: launchpad,
        abi: V4_LAUNCHPAD_ABI,
        functionName: "poolAllocation",
        args: tokenAddr ? [tokenAddr] : undefined,
        query: { enabled: !!tokenAddr },
    });

    const formValid =
        name.trim().length > 0 &&
        symbol.trim().length > 0 &&
        snipeStartBps >= 0 &&
        snipeStartBps <= 5_000 &&
        creatorBps >= 0 &&
        creatorBps <= 1_000 &&
        targetFdvUsd >= 1_000;

    async function onCreate() {
        if (!isConnected || !address) {
            pushToast({ kind: "error", title: "Connect a wallet first" });
            return;
        }
        if (launchpad === zeroAddress) {
            pushToast({ kind: "error", title: "V4 launchpad address not configured" });
            return;
        }
        try {
            setCreateState({ status: "pending", message: "Approving USDC..." });
            await ensureAllowance(CREATION_FEE_USDC);
            setCreateState({ status: "pending", message: "Submitting createLaunch..." });

            const snipeDecaySeconds = snipeStartBps > 0 ? snipeDecayMinutes * 60 : 0;
            const hash = await writeContractAsync({
                address: launchpad,
                abi: V4_LAUNCHPAD_ABI,
                functionName: "createLaunch",
                args: [
                    name.trim(),
                    symbol.trim(),
                    metadataURI.trim(),
                    snipeStartBps,
                    snipeDecaySeconds,
                    creatorBps,
                ],
            });

            setCreateState({ status: "pending", message: "Waiting for confirmation..." });
            if (!publicClient) throw new Error("public client unavailable");
            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            // Pull the new token address out of the TokenLaunched event.
            let newToken: Address | undefined;
            for (const log of receipt.logs) {
                if (log.address.toLowerCase() !== launchpad.toLowerCase()) continue;
                try {
                    const decoded = decodeEventLog({
                        abi: V4_LAUNCHPAD_ABI,
                        data: log.data,
                        topics: log.topics,
                    });
                    if (decoded.eventName === "TokenLaunched") {
                        newToken = (decoded.args as { token: Address }).token;
                        break;
                    }
                } catch {
                    /* not our event */
                }
            }
            if (!newToken) throw new Error("TokenLaunched event not found in receipt");
            setTokenAddr(newToken);
            setCreateState({ status: "success", hash, message: `Token deployed: ${newToken}` });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setCreateState({ status: "error", message: msg });
        }
    }

    async function onInitPool() {
        if (!tokenAddr) return;
        if (!poolAllocation || poolAllocation === 0n) {
            pushToast({ kind: "error", title: "poolAllocation unavailable" });
            return;
        }
        try {
            setInitState({ status: "pending", message: "Computing liquidity..." });
            const { sqrtPriceX96, tokenIsCurrency0 } = sqrtPriceFromFdv(
                targetFdvUsd,
                tokenAddr,
                usdc,
            );
            const { liquidityDelta } = quoteInitializePool({
                sqrtPriceX96,
                tokenIsCurrency0,
                poolAllocation,
                tickSpacing: V4_TICK_SPACING,
            });
            if (liquidityDelta <= 0n) throw new Error("zero liquidity");

            setInitState({ status: "pending", message: "Submitting initializePool..." });
            const hash = await writeContractAsync({
                address: launchpad,
                abi: V4_LAUNCHPAD_ABI,
                functionName: "initializePool",
                args: [tokenAddr, sqrtPriceX96, liquidityDelta],
            });
            setInitState({ status: "pending", message: "Waiting for confirmation..." });
            await publicClient?.waitForTransactionReceipt({ hash });
            setInitState({ status: "success", hash, message: "Pool live" });
            // Small delay so the success state is visible before nav.
            setTimeout(() => router.push("/launchpad"), 800);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setInitState({ status: "error", message: msg });
        }
    }

    return (
        <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
            <div className="mb-6 flex items-center gap-3">
                <Link
                    href="/launchpad"
                    className="rounded-lg border border-arc-border bg-arc-surface p-2 hover:border-arc-primary/40"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Link>
                <div className="flex-1">
                    <h1 className="text-2xl font-semibold">Launch on V4</h1>
                    <p className="text-sm text-arc-text-muted">
                        Anti-sniper hook + single-sided locked LP. Behind feature flag.
                    </p>
                </div>
                <Link
                    href="/launchpad/v4/list"
                    className="rounded-lg border border-arc-border bg-arc-surface px-3 py-1.5 text-xs text-arc-text-muted hover:border-arc-primary/40 hover:text-arc-text"
                >
                    Browse V4 launches
                </Link>
            </div>

            <div className="space-y-5 rounded-2xl border border-arc-border bg-arc-surface p-6">
                {/* Identity ----------------------------------------------- */}
                {/* Stack on very narrow screens; side-by-side from sm (~640px) up. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="text-sm">
                        <span className="text-arc-text-muted">Name</span>
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Arcade Token"
                            className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm focus:border-arc-primary focus:outline-none"
                        />
                    </label>
                    <label className="text-sm">
                        <span className="text-arc-text-muted">Symbol</span>
                        <input
                            value={symbol}
                            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                            placeholder="ARC"
                            className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm focus:border-arc-primary focus:outline-none"
                        />
                    </label>
                </div>
                <label className="block text-sm">
                    <span className="text-arc-text-muted">
                        Metadata URI{" "}
                        <span className="text-xs">(ipfs:// or data:application/json)</span>
                    </span>
                    <input
                        value={metadataURI}
                        onChange={(e) => setMetadataURI(e.target.value)}
                        placeholder="ipfs://bafybeih..."
                        className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm focus:border-arc-primary focus:outline-none"
                    />
                </label>

                {/* Anti-sniper -------------------------------------------- */}
                <div className="rounded-xl border border-arc-border bg-arc-bg p-4">
                    <div className="mb-3 flex items-center justify-between text-sm">
                        <span className="text-arc-text-muted">Snipe tax (starts at)</span>
                        <span>{(snipeStartBps / 100).toFixed(2)}%</span>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={5_000}
                        step={100}
                        value={snipeStartBps}
                        onChange={(e) => setSnipeStartBps(Number(e.target.value))}
                        className="arc-slider w-full"
                        style={{ background: sliderFill((snipeStartBps / 5_000) * 100) }}
                    />
                    <div className="mt-3 flex items-center justify-between text-sm">
                        <span className="text-arc-text-muted">Decay window</span>
                        <span>{snipeDecayMinutes} min</span>
                    </div>
                    <input
                        type="range"
                        min={1}
                        max={60}
                        step={1}
                        value={snipeDecayMinutes}
                        onChange={(e) => setSnipeDecayMinutes(Number(e.target.value))}
                        disabled={snipeStartBps === 0}
                        className="arc-slider w-full"
                        style={{ background: sliderFill((snipeDecayMinutes / 60) * 100) }}
                    />
                </div>

                {/* Creator allocation ------------------------------------- */}
                <div className="rounded-xl border border-arc-border bg-arc-bg p-4">
                    <div className="mb-3 flex items-center justify-between text-sm">
                        <span className="text-arc-text-muted">Creator allocation</span>
                        <span>{(creatorBps / 100).toFixed(2)}%</span>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={1_000}
                        step={25}
                        value={creatorBps}
                        onChange={(e) => setCreatorBps(Number(e.target.value))}
                        className="arc-slider w-full"
                        style={{ background: sliderFill((creatorBps / 1_000) * 100) }}
                    />
                    <p className="mt-2 text-xs text-arc-text-muted">
                        Max 10%. The rest of the 1 B supply locks into the V4 pool as
                        single-sided liquidity.
                    </p>
                </div>

                {/* Starting FDV -------------------------------------------- */}
                <label className="block text-sm">
                    <span className="text-arc-text-muted">Target FDV at launch (USDC)</span>
                    <input
                        type="number"
                        min={1_000}
                        step={1_000}
                        value={targetFdvUsd}
                        onChange={(e) => setTargetFdvUsd(Number(e.target.value))}
                        className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm focus:border-arc-primary focus:outline-none"
                    />
                    <p className="mt-2 text-xs text-arc-text-muted">
                        Sets the pool's starting sqrtPrice. Early buyers move the price up
                        the single-sided curve.
                    </p>
                </label>

                {/* Fee summary --------------------------------------------- */}
                <div className="flex items-center justify-between rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm">
                    <span className="text-arc-text-muted">Creation fee</span>
                    <span>{formatUSDC(CREATION_FEE_USDC)} USDC</span>
                </div>

                {/* Actions ------------------------------------------------- */}
                <div className="flex flex-col gap-3">
                    {!tokenAddr ? (
                        <button
                            onClick={onCreate}
                            disabled={!formValid || createState.status === "pending"}
                            className={cn(
                                "rounded-xl bg-arc-primary px-4 py-3 text-sm font-medium text-white transition hover:bg-arc-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
                            )}
                        >
                            Step 1 — Create launch (pays {formatUSDC(CREATION_FEE_USDC)} USDC)
                        </button>
                    ) : (
                        <button
                            onClick={onInitPool}
                            disabled={initState.status === "pending"}
                            className={cn(
                                "rounded-xl bg-arc-primary px-4 py-3 text-sm font-medium text-white transition hover:bg-arc-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
                            )}
                        >
                            Step 2 — Initialize pool
                        </button>
                    )}
                    <TxStatus state={createState} />
                    <TxStatus state={initState} />
                </div>
            </div>
        </div>
    );
}

// silence unused-import lint
void erc20Abi;
void parseUnits;
