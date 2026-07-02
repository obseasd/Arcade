"use client";

import { Sparkles, Plus, Power, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { Address, isAddress } from "viem";
import { runSequential } from "@/lib/routing/runSequential";

import { ADDRESSES } from "@/lib/constants";
import { V3_NPM_ABI } from "@/lib/abis/v3-npm";
import {
    AUTO_COMPOUNDER_ABI,
    modeLabelFromId,
    type CompounderModeId,
} from "@/lib/abis/autoCompounder";
import { Modal } from "@/components/ui/Modal";
import { pushToast } from "@/lib/toast";
import { cn, formatUSDC } from "@/lib/utils";

// Minimal ERC-721 approve fragment — V3_NPM_ABI in this repo only
// surfaces the V3-specific methods (mint / increaseLiquidity / etc.)
// and the ERC-721 surface is the canonical OpenZeppelin one. The
// argument shape is identical across every OZ release we use, so
// keeping it inline avoids a coupling on the NPM ABI table.
const ERC721_APPROVE_ABI = [
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
            { name: "to", type: "address" },
            { name: "tokenId", type: "uint256" },
        ],
        outputs: [],
    },
] as const;

/**
 * /positions Auto-management section.
 *
 * Fetches the user's currently-managed positions from
 * /api/compounder/positions and renders one card per position with
 * mode badge + pending fees + cooldown countdown. A CTA opens a modal
 * that lists every V3 NFT the connected wallet owns and lets the user
 * pick one, choose a mode, set a threshold, and one-click enable
 * (approve + depositPosition wrapped behind the same UI).
 *
 * The panel hides itself entirely when the compounder address is not
 * yet configured on the frontend — the feature flag is implicit via
 * ADDRESSES.autoCompounder == zeroAddress.
 */

type ManagedPosition = {
    tokenId: string;
    ownerAddress: string;
    mode: "NORMAL" | "RECEIVE" | "COMPOUND";
    minFeeMicros: string;
    maxSlippageBps: number;
    lastActionAt: string | null;
    depositedAt: string;
    withdrawnAt: string | null;
    token0Address: string | null;
    token1Address: string | null;
    feeTier: number | null;
    tickLower: number | null;
    tickUpper: number | null;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function AutoCompounderPanel() {
    const { address: account } = useAccount();
    const enabled = ADDRESSES.autoCompounder !== ZERO_ADDRESS;

    const [positions, setPositions] = useState<ManagedPosition[]>([]);
    const [loading, setLoading] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);

    const refresh = useCallback(async () => {
        if (!account || !enabled) {
            setPositions([]);
            return;
        }
        setLoading(true);
        try {
            const res = await fetch(`/api/compounder/positions?owner=${account}`);
            // Audit 2026-06-18b error-handling: guard res.ok before
            // res.json(). On an HTTP 500 the body may be an error page
            // that fails to parse and throws; this coalesces it into the
            // existing catch (positions = []) instead of an uncaught
            // rejection. No user-visible change on the success path.
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { positions?: ManagedPosition[] };
            setPositions(data.positions ?? []);
        } catch {
            setPositions([]);
        } finally {
            setLoading(false);
        }
    }, [account, enabled]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    if (!enabled) return null;

    // V3Positions now hosts the cards for every position (wallet-owned
    // AND custody-held by the Compounder) since the card design was
    // unified — managed positions get the same USDC/ETH 0.3% / In range
    // / Reserve / MIN/CURRENT/MAX layout with a mode badge in the
    // header and "Total claimed" replacing "Unclaimed fees" at the
    // bottom. This component is now just the standalone "Deposit a
    // position" CTA + modal that surfaces below the position list.
    void positions;
    void loading;
    void refresh;

    // Audit I11 fix: read the on-chain pause flag and gate the deposit
    // CTA when the contract is paused. Without this, a user signs the
    // approve tx (paying gas) and then the safeTransferFrom inside
    // depositPosition reverts at the whenNotPaused guard — burning
    // their gas for a UX dead-end. The button stays visible (so the
    // user knows the feature exists) but greys out + the helper text
    // explains the state.
    const pausedQ = useReadContract({
        address: ADDRESSES.autoCompounder,
        abi: AUTO_COMPOUNDER_ABI,
        functionName: "paused",
        query: { enabled, refetchInterval: 30_000 },
    });
    const contractPaused = pausedQ.data === true;

    return (
        <section className="mt-6">
            {account && contractPaused && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-arc-border bg-arc-bg-elevated/40 p-4">
                    <div className="flex items-center gap-2 text-sm text-arc-text-muted">
                        <Sparkles className="h-4 w-4 text-sky-400" />
                        <span>
                            Auto-management is paused while the team investigates an incident. New deposits are temporarily disabled; existing positions can still withdraw.
                        </span>
                    </div>
                    <button
                        onClick={() => setModalOpen(true)}
                        disabled
                        className="arc-button-secondary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Plus className="h-4 w-4" /> Deposit a position
                    </button>
                </div>
            )}

            {modalOpen && (
                <DepositModal
                    onClose={() => setModalOpen(false)}
                    onDeposited={() => {
                        setModalOpen(false);
                    }}
                />
            )}
        </section>
    );
}

/**
 * Audit I11 fix: live `protocolFeeBps()` reading. The deposit modal
 * used to hard-code "Protocol fee is 1% on collected fees"; the
 * disclosure diverged the moment the owner called
 * setProtocolFeeBps(0) or setProtocolFeeBps(200). This sub-component
 * reads the current bps off the chain so the disclosure always
 * matches what the user will actually pay. Falls back to a
 * placeholder when the read is in flight to avoid a "0%" flash.
 */
function FeeDisclosure() {
    const feeQ = useReadContract({
        address: ADDRESSES.autoCompounder,
        abi: AUTO_COMPOUNDER_ABI,
        functionName: "protocolFeeBps",
        query: {
            enabled: ADDRESSES.autoCompounder !== ZERO_ADDRESS,
            // bps almost never changes — a 5-minute stale read is fine
            // and avoids polling the RPC for a constant the cron
            // already reads on every tick.
            staleTime: 5 * 60 * 1000,
        },
    });
    const bpsValue = feeQ.data;
    const bpsNumber: number =
        typeof bpsValue === "bigint"
            ? Number(bpsValue)
            : typeof bpsValue === "number"
              ? bpsValue
              : 100;
    const pct = (bpsNumber / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return (
        <div className="rounded-xl border border-arc-border bg-arc-bg p-3 text-[11px] leading-relaxed text-arc-text-muted">
            Protocol fee is{" "}
            <span className="font-semibold text-arc-text">{pct}%</span>{" "}
            on the fees the keeper collects. The contract caps the rate at
            5% on-chain so a future owner cannot grow it past that ceiling.
        </div>
    );
}

// -------------------------------------------------------------------
// Managed position card
// -------------------------------------------------------------------

function ManagedPositionCard({
    position,
    onChanged,
}: {
    position: ManagedPosition;
    onChanged: () => void;
}) {
    const tokenId = BigInt(position.tokenId);
    const { writeContractAsync } = useWriteContract();
    const [busy, setBusy] = useState(false);

    const pendingQ = useReadContract({
        address: ADDRESSES.autoCompounder,
        abi: AUTO_COMPOUNDER_ABI,
        functionName: "pendingFees",
        args: [tokenId],
        query: { refetchInterval: 60_000 },
    });
    const nextAtQ = useReadContract({
        address: ADDRESSES.autoCompounder,
        abi: AUTO_COMPOUNDER_ABI,
        functionName: "nextActionAvailableAt",
        args: [tokenId],
        query: { refetchInterval: 60_000 },
    });

    const pending = pendingQ.data as readonly [bigint, bigint] | undefined;
    const nextAt = (nextAtQ.data as bigint | undefined) ?? 0n;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const cooldownActive = nextAt > nowSec;
    const cooldownLeft = cooldownActive ? Number(nextAt - nowSec) : 0;

    const withdraw = useCallback(async () => {
        setBusy(true);
        try {
            await writeContractAsync({
                address: ADDRESSES.autoCompounder,
                abi: AUTO_COMPOUNDER_ABI,
                functionName: "withdrawPosition",
                args: [tokenId],
            });
            await fetch("/api/compounder/positions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "withdraw", tokenId: position.tokenId }),
            });
            pushToast({
                kind: "info",
                title: "Position withdrawn",
                message: "Auto-management ended. NFT returned to your wallet.",
            });
            onChanged();
        } catch (err) {
            pushToast({
                kind: "error",
                title: "Withdraw failed",
                message: err instanceof Error ? err.message : "Unknown error",
            });
        } finally {
            setBusy(false);
        }
    }, [onChanged, position.tokenId, tokenId, writeContractAsync]);

    return (
        <div className="arc-card p-5">
            <div className="mb-3 flex items-center justify-between">
                <div>
                    <div className="text-xs uppercase tracking-wider text-arc-text-faint">
                        Position #{position.tokenId}
                    </div>
                    <div className="mt-1 inline-flex items-center gap-2">
                        <ModeBadge mode={position.mode} />
                        {cooldownActive ? (
                            <span className="text-[10px] text-arc-text-faint">
                                Cooldown: {formatCountdown(cooldownLeft)}
                            </span>
                        ) : (
                            <span className="text-[10px] text-arc-success">Ready</span>
                        )}
                    </div>
                </div>
                <button
                    onClick={withdraw}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-lg border border-arc-border px-3 py-1.5 text-xs text-arc-text-muted transition-colors hover:bg-arc-surface-2 hover:text-arc-text disabled:opacity-50"
                >
                    <Power className="h-3 w-3" /> Stop
                </button>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-xs">
                <div>
                    <dt className="text-arc-text-faint">Threshold</dt>
                    <dd className="mt-1 font-medium tabular-nums text-arc-text">
                        {formatUSDC(BigInt(position.minFeeMicros))} USDC
                    </dd>
                </div>
                <div>
                    <dt className="text-arc-text-faint">Slippage</dt>
                    <dd className="mt-1 font-medium tabular-nums text-arc-text">
                        {(position.maxSlippageBps / 100).toFixed(2)}%
                    </dd>
                </div>
                <div>
                    <dt className="text-arc-text-faint">Pending fees</dt>
                    <dd className="mt-1 font-medium tabular-nums text-arc-text">
                        {pending
                            ? `${pending[0].toString()} / ${pending[1].toString()}`
                            : "…"}
                    </dd>
                </div>
                <div>
                    <dt className="text-arc-text-faint">Last action</dt>
                    <dd className="mt-1 font-medium tabular-nums text-arc-text">
                        {position.lastActionAt
                            ? new Date(position.lastActionAt).toLocaleString()
                            : "Never"}
                    </dd>
                </div>
            </dl>
        </div>
    );
}

function ModeBadge({ mode }: { mode: ManagedPosition["mode"] }) {
    const config: Record<ManagedPosition["mode"], { label: string; cls: string }> = {
        NORMAL: { label: "Normal", cls: "bg-arc-surface-2 text-arc-text-muted" },
        RECEIVE: { label: "Auto-receive", cls: "bg-sky-400/10 text-sky-400" },
        COMPOUND: { label: "Auto-compound", cls: "bg-arc-success/10 text-arc-success" },
    };
    const { label, cls } = config[mode];
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                cls,
            )}
        >
            {label}
        </span>
    );
}

function formatCountdown(seconds: number): string {
    if (seconds <= 0) return "ready";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// -------------------------------------------------------------------
// Deposit modal
// -------------------------------------------------------------------

function DepositModal({
    onClose,
    onDeposited,
}: {
    onClose: () => void;
    onDeposited: () => void;
}) {
    const { address: account } = useAccount();
    const { writeContractAsync } = useWriteContract();
    const publicClient = usePublicClient();

    const [tokenIdInput, setTokenIdInput] = useState("");
    const [mode, setMode] = useState<CompounderModeId>(1); // default RECEIVE
    // Default at the contract's MIN_FEE_MICROS_FLOOR (1 USDC). The old "0.10"
    // default produced 100_000 micros and depositPosition reverted with
    // MIN_FEE_TOO_LOW on the no-edit happy path (pages audit 2026-07-02).
    const [thresholdUsdc, setThresholdUsdc] = useState("1.00");
    const [slippagePct, setSlippagePct] = useState("0.50");
    const [busy, setBusy] = useState(false);
    const [step, setStep] = useState<"idle" | "approving" | "depositing">("idle");

    // List the user's V3 NFTs as a selector so they don't have to type the
    // tokenId from memory. Reads balanceOf -> tokenOfOwnerByIndex(0..N-1).
    const balanceQ = useReadContract({
        address: ADDRESSES.v3PositionManager,
        abi: V3_NPM_ABI,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });
    const count = Number((balanceQ.data as bigint | undefined) ?? 0n);
    const tokenIdsQ = useReadContracts({
        contracts: account
            ? Array.from({ length: count }, (_, i) => ({
                  address: ADDRESSES.v3PositionManager,
                  abi: V3_NPM_ABI,
                  functionName: "tokenOfOwnerByIndex" as const,
                  args: [account, BigInt(i)] as const,
              }))
            : [],
        query: { enabled: !!account && count > 0 },
    });
    const userTokenIds = useMemo(
        () =>
            (tokenIdsQ.data ?? [])
                .map((c) => (c.status === "success" ? (c.result as bigint) : undefined))
                .filter((x): x is bigint => x !== undefined)
                .map((b) => b.toString()),
        [tokenIdsQ.data],
    );

    const tokenIdToUse = tokenIdInput || userTokenIds[0] || "";
    // ArcadeAutoCompounder enforces MIN_FEE_MICROS_FLOOR = 1_000_000 (1 USDC).
    const MIN_THRESHOLD_USDC = 1.0;
    const thresholdMicros = useMemo(() => {
        const parsed = Number(thresholdUsdc);
        if (!Number.isFinite(parsed) || parsed < 0) return 1_000_000n;
        const micros = BigInt(Math.floor(parsed * 1_000_000));
        // Clamp to the on-chain floor so a sub-1-USDC input can't reach
        // depositPosition and revert MIN_FEE_TOO_LOW.
        return micros < 1_000_000n ? 1_000_000n : micros;
    }, [thresholdUsdc]);
    // Snap the input up to the floor when the user leaves the field, so they
    // see the bumped value rather than silently sending a different one.
    const onThresholdBlur = useCallback(() => {
        const parsed = Number(thresholdUsdc);
        if (!Number.isFinite(parsed) || parsed < MIN_THRESHOLD_USDC) {
            setThresholdUsdc(MIN_THRESHOLD_USDC.toFixed(2));
        }
    }, [thresholdUsdc]);
    const slippageBps = useMemo(() => {
        const parsed = Number(slippagePct);
        if (!Number.isFinite(parsed) || parsed < 0) return 50;
        return Math.min(10_000, Math.floor(parsed * 100));
    }, [slippagePct]);

    const deposit = useCallback(async () => {
        if (!account) return;
        if (!tokenIdToUse || !/^\d+$/.test(tokenIdToUse)) {
            pushToast({
                kind: "error",
                title: "Invalid token ID",
                message: "Pick a position or enter a numeric token id.",
            });
            return;
        }
        if (!isAddress(ADDRESSES.autoCompounder, { strict: false })) {
            pushToast({
                kind: "error",
                title: "Compounder address not configured",
                message: "NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS is not set.",
            });
            return;
        }
        setBusy(true);
        try {
            // Arc's callFrom precompile is dead, so the old "approve +
            // deposit in one signature" Multicall3From batch reverts
            // on-chain. Run the two legs as direct txs from the user's
            // wallet, in order: ERC-721 approve(tokenId) to the compounder,
            // then depositPosition. The compounder's
            // safeTransferFrom(msg.sender) inside depositPosition still
            // pulls from the user because each tx is signed by the user.
            await runSequential(
                [
                    {
                        address: ADDRESSES.v3PositionManager,
                        abi: ERC721_APPROVE_ABI,
                        functionName: "approve",
                        args: [ADDRESSES.autoCompounder as Address, BigInt(tokenIdToUse)],
                    },
                    {
                        address: ADDRESSES.autoCompounder as Address,
                        abi: AUTO_COMPOUNDER_ABI,
                        functionName: "depositPosition",
                        args: [BigInt(tokenIdToUse), mode, thresholdMicros, slippageBps],
                    },
                ],
                {
                    writeContractAsync,
                    publicClient,
                    onStep: (i) => setStep(i === 0 ? "approving" : "depositing"),
                },
            );

            // Step 3: mirror to DB so the cron picks it up immediately
            // (the scanner queries the DB, not the chain).
            await fetch("/api/compounder/positions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "upsert",
                    tokenId: tokenIdToUse,
                    ownerAddress: account,
                    mode: modeLabelFromId(mode),
                    minFeeMicros: thresholdMicros.toString(),
                    maxSlippageBps: slippageBps,
                }),
            });

            pushToast({
                kind: "info",
                title: "Position under auto-management",
                message: `Token #${tokenIdToUse} is now ${modeLabelFromId(mode).toLowerCase()}.`,
            });
            onDeposited();
        } catch (err) {
            pushToast({
                kind: "error",
                title: "Deposit failed",
                message: err instanceof Error ? err.message : "Unknown error",
            });
        } finally {
            setBusy(false);
            setStep("idle");
        }
    }, [
        account,
        mode,
        onDeposited,
        slippageBps,
        thresholdMicros,
        tokenIdToUse,
        writeContractAsync,
        publicClient,
    ]);

    return (
        <Modal open onClose={busy ? () => {} : onClose}>
            <div className="space-y-5 p-5">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-arc-text">
                        Deposit V3 LP into auto-management
                    </h3>
                    <button
                        type="button"
                        onClick={busy ? undefined : onClose}
                        disabled={busy}
                        aria-label="Close"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-arc-text-muted hover:bg-arc-surface-2 hover:text-arc-text disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div>
                    <label className="mb-2 block text-xs uppercase tracking-wider text-arc-text-muted">
                        Position
                    </label>
                    {userTokenIds.length > 0 ? (
                        <select
                            value={tokenIdInput || userTokenIds[0]}
                            onChange={(e) => setTokenIdInput(e.target.value)}
                            disabled={busy}
                            className="w-full rounded-xl border border-arc-border bg-arc-bg p-3 text-sm text-arc-text outline-none focus:border-arc-primary"
                        >
                            {userTokenIds.map((id) => (
                                <option key={id} value={id}>
                                    Token #{id}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            inputMode="numeric"
                            placeholder="Token ID"
                            value={tokenIdInput}
                            onChange={(e) =>
                                setTokenIdInput(e.target.value.replace(/[^\d]/g, ""))
                            }
                            disabled={busy}
                            className="w-full rounded-xl border border-arc-border bg-arc-bg p-3 text-sm text-arc-text outline-none focus:border-arc-primary"
                        />
                    )}
                </div>

                <div>
                    <label className="mb-2 block text-xs uppercase tracking-wider text-arc-text-muted">
                        Mode
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        {(
                            [
                                { id: 0, title: "Normal", body: "Tracked, no actions." },
                                { id: 1, title: "Auto-receive", body: "Push fees to wallet." },
                                { id: 2, title: "Auto-compound", body: "Reinvest into position." },
                            ] as const
                        ).map((opt) => {
                            const active = mode === opt.id;
                            return (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => setMode(opt.id as CompounderModeId)}
                                    disabled={busy}
                                    className={cn(
                                        "rounded-xl border p-3 text-left text-xs transition-colors",
                                        active
                                            ? "border-sky-400 bg-sky-400/5"
                                            : "border-arc-border bg-arc-bg hover:border-arc-border-strong",
                                    )}
                                >
                                    <div className="font-semibold text-arc-text">
                                        {opt.title}
                                    </div>
                                    <div className="mt-1 text-[10px] text-arc-text-muted">
                                        {opt.body}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="mb-2 block text-xs uppercase tracking-wider text-arc-text-muted">
                            Threshold (USDC)
                        </label>
                        <input
                            type="text"
                            inputMode="decimal"
                            value={thresholdUsdc}
                            onChange={(e) => setThresholdUsdc(e.target.value)}
                            onBlur={onThresholdBlur}
                            disabled={busy}
                            className="w-full rounded-xl border border-arc-border bg-arc-bg p-3 text-sm text-arc-text outline-none focus:border-arc-primary"
                        />
                        <p className="mt-1 text-[10px] text-arc-text-faint">
                            Trigger when pending fees ≥ this amount (min 1 USDC).
                        </p>
                    </div>
                    <div>
                        <label className="mb-2 block text-xs uppercase tracking-wider text-arc-text-muted">
                            Slippage (%)
                        </label>
                        <input
                            type="text"
                            inputMode="decimal"
                            value={slippagePct}
                            onChange={(e) => setSlippagePct(e.target.value)}
                            disabled={busy}
                            className="w-full rounded-xl border border-arc-border bg-arc-bg p-3 text-sm text-arc-text outline-none focus:border-arc-primary"
                        />
                        <p className="mt-1 text-[10px] text-arc-text-faint">
                            Compound mode only. 0.50% is conservative.
                        </p>
                    </div>
                </div>

                <FeeDisclosure />
                <div className="rounded-xl border border-arc-border bg-arc-bg p-3 text-[11px] leading-relaxed text-arc-text-muted">
                    Deposit requires two signatures: (1) approve the
                    Compounder to take the NFT, (2) call depositPosition.
                    You can withdraw the NFT at any time.
                </div>

                <div className="flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="rounded-xl border border-arc-border px-4 py-2 text-sm text-arc-text-muted hover:bg-arc-surface-2"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => void deposit()}
                        disabled={busy || !account || !tokenIdToUse}
                        className="arc-button-primary px-5 py-2 text-sm"
                    >
                        {step === "approving"
                            ? "Approving…"
                            : step === "depositing"
                            ? "Depositing…"
                            : "Enable auto-management"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
