"use client";

import {
    AlertTriangle,
    ArrowLeft,
    ArrowRight,
    BarChart3,
    CheckCircle2,
    Clock,
    Lock,
    LogIn,
    Pause,
    Play,
    RefreshCw,
    Shield,
    UserCog,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Address, erc20Abi, isAddress, parseUnits, zeroAddress } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { pushToast } from "@/lib/toast";
import { cn, formatAddress, formatUSDC } from "@/lib/utils";

/**
 * Owner-only escrow admin panel. Gated client-side by checking the
 * connected wallet against `escrow.owner()`. The contract enforces the
 * real authorization on every write so a "wallet spoof" can only see
 * the same view data that is already public via `cast call`.
 *
 * Layout: each subsystem (timelock, signer, pause, rescue, locker
 * rotation, ownership) is its own card so the operator can scan the
 * page top-to-bottom during incident response.
 */
export default function EscrowAdminPage() {
    const { address: account } = useAccount();
    const escrow = ADDRESSES.twitterEscrow;

    const ownerQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "owner",
        query: { enabled: !!escrow },
    });
    const owner = ownerQ.data as Address | undefined;
    const isOwner =
        !!account && !!owner && owner.toLowerCase() === account.toLowerCase();

    if (!account) {
        return (
            <UnauthorizedShell
                title="Connect your wallet"
                body="The escrow admin panel is gated on the escrow contract's owner. Connect with the owner wallet to continue."
            />
        );
    }

    if (!isOwner) {
        return (
            <UnauthorizedShell
                title="Not the escrow owner"
                body={
                    <span>
                        This wallet is <code>{formatAddress(account)}</code>. The escrow owner
                        is <code>{owner ? formatAddress(owner) : "(loading)"}</code>. Switch
                        wallets to access admin controls.
                    </span>
                }
            />
        );
    }

    return <AdminBody />;
}

function UnauthorizedShell({ title, body }: { title: string; body: React.ReactNode }) {
    return (
        <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
            <Link
                href="/"
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> Home
            </Link>
            <div className="arc-card p-6">
                <div className="flex items-center gap-2 text-arc-warn">
                    <Shield className="h-5 w-5" />
                    <h1 className="text-lg font-semibold">{title}</h1>
                </div>
                <p className="mt-3 text-sm text-arc-text-muted">{body}</p>
            </div>
        </div>
    );
}

function AdminBody() {
    return (
        <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
            <Link
                href="/"
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> Home
            </Link>

            <div className="mb-8 flex items-start gap-3">
                <Shield className="mt-1 h-6 w-6 text-arc-cta-hover" />
                <div>
                    <h1 className="text-3xl font-semibold sm:text-4xl">Escrow admin</h1>
                    <p className="mt-1 text-sm text-arc-text-muted">
                        Operational controls for the ArcadeTwitterEscrow V3 contract. Every
                        write transaction is gated on-chain by <code>onlyOwner</code>.
                    </p>
                </div>
            </div>

            <Link
                href="/stats"
                className="mb-6 flex items-center justify-between gap-4 rounded-2xl border border-arc-cta-hover/30 bg-arc-cta-hover/5 p-4 transition-colors hover:bg-arc-cta-hover/10 sm:p-5"
            >
                <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-arc-cta-hover/15 text-arc-cta-hover">
                        <BarChart3 className="h-5 w-5" />
                    </div>
                    <div>
                        <div className="text-sm font-semibold text-arc-text">
                            View public stats dashboard
                        </div>
                        <div className="mt-0.5 text-xs text-arc-text-muted">
                            USDC gas paid, transactions routed, unique wallets, tokens
                            launched. The canonical attribution surface for Circle and Arc
                            partners.
                        </div>
                    </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-arc-cta-hover" />
            </Link>

            <div className="space-y-5">
                <StatusCard />
                <PauseCard />
                <TimelockCard />
                <SignerCard />
                <PullFromLockerCard />
                <LockerRotationCard />
                <ForfeitCard />
                <RescueCard />
                <OwnershipCard />
            </div>
        </div>
    );
}

// ===================== Status =====================

function StatusCard() {
    const escrow = ADDRESSES.twitterEscrow;
    const pausedQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "paused",
    });
    const timelockQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "claimTimelock",
    });
    const signerQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "trustedSigner",
    });
    const ownerQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "owner",
    });
    const lockerQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "LOCKER",
    });

    const paused = !!(pausedQ.data as boolean | undefined);
    const timelockSec = Number((timelockQ.data as bigint | undefined) ?? 0n);

    return (
        <Card title="Status" icon={<CheckCircle2 className="h-4 w-4" />}>
            <Row label="Address" value={escrow} mono />
            <Row label="Owner" value={(ownerQ.data as Address | undefined) ?? "(loading)"} mono />
            <Row
                label="Trusted signer"
                value={(signerQ.data as Address | undefined) ?? "(loading)"}
                mono
            />
            <Row label="Locker (wired)" value={(lockerQ.data as Address | undefined) ?? "(loading)"} mono />
            <Row
                label="Paused"
                value={
                    <span className={paused ? "text-arc-warn" : "text-arc-success"}>
                        {paused ? "YES — claims blocked" : "no"}
                    </span>
                }
            />
            <Row
                label="Claim timelock"
                value={`${Math.floor(timelockSec / 3600)}h ${Math.floor((timelockSec % 3600) / 60)}m ${timelockSec % 60}s (${timelockSec} sec)`}
            />
        </Card>
    );
}

// ===================== Pause =====================

function PauseCard() {
    const escrow = ADDRESSES.twitterEscrow;
    const { writeContractAsync } = useWriteContract();
    const [submitting, setSubmitting] = useState(false);
    const pausedQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "paused",
    });
    const paused = !!(pausedQ.data as boolean | undefined);

    const onToggle = async () => {
        setSubmitting(true);
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: paused ? "unpause" : "pause",
            });
            await pausedQ.refetch();
            pushToast({ kind: "info", title: paused ? "Escrow unpaused" : "Escrow paused" });
        } catch (e: any) {
            pushToast({ kind: "error", title: "Failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Card
            title={paused ? "Unpause" : "Pause"}
            icon={paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        >
            <p className="text-xs text-arc-text-muted">
                Pause freezes new <code>authorize</code> calls and <code>claimByTwitter</code>{" "}
                payouts. <code>creditSlot</code>, <code>veto</code>, and the admin functions
                stay live so the locker keeps depositing and you can still respond to incidents.
            </p>
            <button type="button"
                onClick={onToggle}
                disabled={submitting}
                className={cn(
                    "mt-4 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold",
                    paused ? "bg-arc-success/15 text-arc-success" : "bg-arc-warn/15 text-arc-warn",
                    submitting && "opacity-60",
                )}
            >
                {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                {submitting ? "Sending…" : paused ? "Unpause escrow" : "Pause escrow"}
            </button>
        </Card>
    );
}

// ===================== Timelock =====================

function TimelockCard() {
    const escrow = ADDRESSES.twitterEscrow;
    const { writeContractAsync } = useWriteContract();
    const timelockQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "claimTimelock",
    });
    const minQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "MIN_TIMELOCK",
    });
    const maxQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "MAX_TIMELOCK",
    });
    const currentSec = Number((timelockQ.data as bigint | undefined) ?? 0n);
    const minSec = Number((minQ.data as bigint | undefined) ?? 3600n);
    const maxSec = Number((maxQ.data as bigint | undefined) ?? 604800n);

    const [hoursStr, setHoursStr] = useState(String(Math.max(1, Math.round(currentSec / 3600))));
    const [submitting, setSubmitting] = useState(false);

    const requestedSec = (() => {
        const h = Number(hoursStr);
        return Number.isFinite(h) ? Math.round(h * 3600) : 0;
    })();
    const valid = requestedSec >= minSec && requestedSec <= maxSec;

    const onSubmit = async () => {
        if (!valid) return;
        setSubmitting(true);
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "setClaimTimelock",
                args: [BigInt(requestedSec)],
            });
            await timelockQ.refetch();
            pushToast({ kind: "info", title: "Timelock updated" });
        } catch (e: any) {
            pushToast({ kind: "error", title: "Failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Card title="Claim timelock" icon={<Lock className="h-4 w-4" />}>
            <p className="text-xs text-arc-text-muted">
                Window between <code>authorize</code> and the earliest{" "}
                <code>claimByTwitter</code>. The veto power lives here. Defaults to 1 hour at
                deploy; raise to 24h or 48h once the operator runbook is solid. Bounded between
                <span className="font-medium text-arc-text"> {Math.floor(minSec / 3600)}h </span>
                and
                <span className="font-medium text-arc-text"> {Math.floor(maxSec / 86400)}d </span>
                on-chain.
            </p>
            <div className="mt-3 text-sm">
                Current:{" "}
                <span className="font-semibold tabular-nums">
                    {Math.floor(currentSec / 3600)}h {Math.floor((currentSec % 3600) / 60)}m
                </span>
            </div>
            <div className="mt-4 flex items-center gap-2">
                <input
                    aria-label="Timelock hours"
                    type="number"
                    min={1}
                    max={168}
                    step={1}
                    value={hoursStr}
                    onChange={(e) => setHoursStr(e.target.value)}
                    className="arc-input w-24 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm"
                />
                <span className="text-xs text-arc-text-muted">hours</span>
                <button type="button"
                    onClick={onSubmit}
                    disabled={!valid || submitting}
                    className={cn("arc-button-primary ml-auto px-4 py-2 text-sm", (!valid || submitting) && "opacity-60")}
                >
                    {submitting ? "Sending…" : "Update timelock"}
                </button>
            </div>
            {!valid && (
                <p className="mt-2 text-xs text-arc-danger">
                    Must be between {Math.floor(minSec / 3600)}h and {Math.floor(maxSec / 3600)}h.
                </p>
            )}
        </Card>
    );
}

// ===================== Trusted signer =====================

function SignerCard() {
    // Audit 2026-06-18 M-12: the v3 escrow replaced the immediate
    // setTrustedSigner with a 2-step + 24h timelock flow. The
    // previous version of this card called the deprecated
    // setTrustedSigner which reverts USE_TIMELOCK_ROTATION on every
    // attempt, so the operator could not actually rotate the signer
    // through the UI during an incident. This rewrite surfaces the
    // request / cancel / finalize states inline so the operator can
    // start the rotation, see the active timer, cancel if mistaken,
    // and finalize once the 24h window elapses, all without ever
    // touching foundry / cast.
    const escrow = ADDRESSES.twitterEscrow;
    const { writeContractAsync } = useWriteContract();
    const signerQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "trustedSigner",
    });
    const pendingQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "pendingTrustedSigner",
        query: { refetchInterval: 15_000 },
    });
    const notBeforeQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "trustedSignerNotBefore",
        query: { refetchInterval: 15_000 },
    });
    const current = signerQ.data as Address | undefined;
    const pending = pendingQ.data as Address | undefined;
    const notBefore = (notBeforeQ.data as bigint | undefined) ?? 0n;
    const hasPending = !!pending && pending !== zeroAddress;
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
    useEffect(() => {
        if (!hasPending) return;
        const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(id);
    }, [hasPending]);
    const secondsLeft = Number(notBefore) - now;
    const timerElapsed = hasPending && secondsLeft <= 0;

    const [next, setNext] = useState("");
    const [submitting, setSubmitting] = useState<
        null | "request" | "cancel" | "finalize"
    >(null);
    const valid = isAddress(next.trim()) && next.trim() !== zeroAddress;

    const refetchAll = async () => {
        await Promise.all([signerQ.refetch(), pendingQ.refetch(), notBeforeQ.refetch()]);
    };

    const onRequest = async () => {
        if (!valid) return;
        if (
            !window.confirm(
                `Stage trusted signer rotation to ${next.trim()}? The 24h timelock starts now. The old signer stays active until you call finalize after the window elapses.`,
            )
        )
            return;
        setSubmitting("request");
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "requestTrustedSignerRotation",
                args: [next.trim() as Address],
            });
            await refetchAll();
            setNext("");
            pushToast({
                kind: "info",
                title: "Rotation requested",
                message: "Timelock starts now; finalize in 24h.",
            });
        } catch (e: any) {
            pushToast({ kind: "error", title: "Request failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(null);
        }
    };

    const onCancel = async () => {
        if (!window.confirm("Cancel pending rotation? Pending signer will be reset to zero.")) return;
        setSubmitting("cancel");
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "cancelTrustedSignerRotation",
                args: [],
            });
            await refetchAll();
            pushToast({ kind: "info", title: "Rotation cancelled" });
        } catch (e: any) {
            pushToast({ kind: "error", title: "Cancel failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(null);
        }
    };

    const onFinalize = async () => {
        if (
            !window.confirm(
                `Finalize rotation? The trusted signer will be replaced with ${pending} immediately on the next block. Existing already-authorized claims signed by the old signer remain valid until their timelock window elapses.`,
            )
        )
            return;
        setSubmitting("finalize");
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "finalizeTrustedSignerRotation",
                args: [],
            });
            await refetchAll();
            pushToast({ kind: "info", title: "Signer rotated" });
        } catch (e: any) {
            pushToast({ kind: "error", title: "Finalize failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(null);
        }
    };

    return (
        <Card title="Trusted signer" icon={<UserCog className="h-4 w-4" />}>
            <p className="text-xs text-arc-text-muted">
                The EIP-712 backend signer. Rotation is 2-step with a 24h timelock.
                <span className="font-medium text-arc-warn"> In-flight pending
                claims that have already passed authorize remain executable</span> until
                their timelock window elapses; pause + veto each one if needed.
            </p>
            <Row label="Current signer" value={current ?? "(loading)"} mono />
            {hasPending ? (
                <>
                    <Row label="Pending signer" value={pending} mono />
                    <Row
                        label={timerElapsed ? "Timelock" : "Time remaining"}
                        value={
                            timerElapsed
                                ? "Elapsed, ready to finalize"
                                : formatDuration(secondsLeft)
                        }
                    />
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={onFinalize}
                            disabled={!timerElapsed || submitting !== null}
                            className={cn(
                                "arc-button-primary px-4 py-2 text-sm",
                                (!timerElapsed || submitting !== null) && "opacity-60",
                            )}
                        >
                            {submitting === "finalize" ? "Sending…" : "Finalize rotation"}
                        </button>
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={submitting !== null}
                            className={cn(
                                "arc-button-secondary px-4 py-2 text-sm",
                                submitting !== null && "opacity-60",
                            )}
                        >
                            {submitting === "cancel" ? "Sending…" : "Cancel rotation"}
                        </button>
                    </div>
                </>
            ) : (
                <div className="mt-4 flex items-center gap-2">
                    <input
                        aria-label="New signer address"
                        type="text"
                        placeholder="0x… new signer address"
                        value={next}
                        onChange={(e) => setNext(e.target.value)}
                        className="arc-input flex-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
                    />
                    <button
                        type="button"
                        onClick={onRequest}
                        disabled={!valid || submitting !== null}
                        className={cn(
                            "arc-button-primary px-4 py-2 text-sm",
                            (!valid || submitting !== null) && "opacity-60",
                        )}
                    >
                        {submitting === "request" ? "Sending…" : "Request rotation"}
                    </button>
                </div>
            )}
        </Card>
    );
}

function formatDuration(seconds: number): string {
    if (seconds <= 0) return "0s";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// ===================== Pull from locker =====================

function PullFromLockerCard() {
    const escrow = ADDRESSES.twitterEscrow;
    const { writeContractAsync } = useWriteContract();
    const [tokenInput, setTokenInput] = useState<string>(ADDRESSES.usdc);
    const [submitting, setSubmitting] = useState(false);
    const valid = isAddress(tokenInput.trim());

    const onSubmit = async () => {
        if (!valid) return;
        setSubmitting(true);
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "pullFromLocker",
                args: [tokenInput.trim() as Address],
            });
            pushToast({ kind: "info", title: "Pulled from locker" });
        } catch (e: any) {
            pushToast({ kind: "error", title: "Failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Card title="Pull from locker (H-08 recovery)" icon={<RefreshCw className="h-4 w-4" />}>
            <p className="text-xs text-arc-text-muted">
                Withdraws tokens that the locker credited to the escrow&apos;s pending-payments
                ledger (e.g. a transfer that briefly failed inline and got credited via the
                fallback). The pulled tokens land in the escrow&apos;s free balance and can
                then be moved with the rescue function below. Idempotent: calling for a
                token with zero pending balance reverts cleanly.
            </p>
            <div className="mt-4 flex items-center gap-2">
                <input
                    aria-label="Token address"
                    type="text"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    className="arc-input flex-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
                />
                <button type="button"
                    onClick={onSubmit}
                    disabled={!valid || submitting}
                    className={cn("arc-button-primary px-4 py-2 text-sm", (!valid || submitting) && "opacity-60")}
                >
                    {submitting ? "Sending…" : "Pull"}
                </button>
            </div>
        </Card>
    );
}

// ===================== Locker rotation =====================

function LockerRotationCard() {
    const escrow = ADDRESSES.twitterEscrow;
    const { writeContractAsync } = useWriteContract();
    const [positionIdStr, setPositionIdStr] = useState("");
    const [slotIndexStr, setSlotIndexStr] = useState("");
    const [addr, setAddr] = useState("");
    const [submitting, setSubmitting] = useState<"recipient" | "admin" | null>(null);

    const validAddr = isAddress(addr.trim());
    const validIds = positionIdStr.trim() !== "" && slotIndexStr.trim() !== "";
    const canSubmit = validAddr && validIds;

    const run = async (which: "recipient" | "admin") => {
        if (!canSubmit) return;
        setSubmitting(which);
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: which === "recipient" ? "rotateLockerRecipient" : "rotateLockerAdmin",
                args: [BigInt(positionIdStr.trim()), BigInt(slotIndexStr.trim()), addr.trim() as Address],
            });
            pushToast({
                kind: "info",
                title: `Rotated ${which}`,
            });
        } catch (e: any) {
            pushToast({ kind: "error", title: "Failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(null);
        }
    };

    return (
        <Card title="Locker rotation (M-12 recovery)" icon={<UserCog className="h-4 w-4" />}>
            <p className="text-xs text-arc-text-muted">
                Forwards <code>updateRecipient</code> / <code>updateAdmin</code> calls to the
                V3 locker for slots whose owner is the escrow contract (the typical
                Twitter-attributed slot). Useful when the post-claim auto-rotation in
                <code> claimByTwitter</code> failed in the try/catch and the slot is stuck
                pointing at the escrow.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
                <input
                    aria-label="Position ID"
                    type="number"
                    min={0}
                    placeholder="positionId"
                    value={positionIdStr}
                    onChange={(e) => setPositionIdStr(e.target.value)}
                    className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm"
                />
                <input
                    aria-label="Slot index"
                    type="number"
                    min={0}
                    placeholder="slotIndex"
                    value={slotIndexStr}
                    onChange={(e) => setSlotIndexStr(e.target.value)}
                    className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm"
                />
            </div>
            <input
                aria-label="New recipient or admin address"
                type="text"
                placeholder="0x… new recipient / admin"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                className="arc-input mt-2 w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
            />
            <div className="mt-3 flex gap-2">
                <button type="button"
                    onClick={() => run("recipient")}
                    disabled={!canSubmit || submitting !== null}
                    className={cn("arc-button-primary flex-1 px-4 py-2 text-sm", (!canSubmit || submitting !== null) && "opacity-60")}
                >
                    {submitting === "recipient" ? "Sending…" : "Rotate recipient"}
                </button>
                <button type="button"
                    onClick={() => run("admin")}
                    disabled={!canSubmit || submitting !== null}
                    className={cn("arc-button-primary flex-1 px-4 py-2 text-sm", (!canSubmit || submitting !== null) && "opacity-60")}
                >
                    {submitting === "admin" ? "Sending…" : "Rotate admin"}
                </button>
            </div>
        </Card>
    );
}

// ===================== Forfeit stale claim =====================

function ForfeitCard() {
    const escrow = ADDRESSES.twitterEscrow;
    const { writeContractAsync } = useWriteContract();
    const [positionIdStr, setPositionIdStr] = useState("");
    const [slotIndexStr, setSlotIndexStr] = useState("");
    const [pairedStr, setPairedStr] = useState<string>(ADDRESSES.usdc);
    const [clankerStr, setClankerStr] = useState<string>("");
    const [toStr, setToStr] = useState<string>("");
    const [submitting, setSubmitting] = useState(false);

    const forfeitDelayQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "FORFEIT_DELAY",
    });
    const delaySec = Number((forfeitDelayQ.data as bigint | undefined) ?? 0n);

    const idsValid = positionIdStr.trim() !== "" && slotIndexStr.trim() !== "";
    const positionId = idsValid ? BigInt(positionIdStr.trim()) : 0n;
    const slotIndex = idsValid ? BigInt(slotIndexStr.trim()) : 0n;

    // Read on-chain state of the slot to show the operator what they're
    // about to forfeit. Disabled until the position/slot pair is filled in.
    const lastCreditedAtQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "lastCreditedAt",
        args: [positionId, slotIndex],
        query: { enabled: idsValid },
    });
    const claimedQ = useReadContract({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "claimed",
        args: [positionId, slotIndex],
        query: { enabled: idsValid },
    });
    const lastSec = Number((lastCreditedAtQ.data as bigint | undefined) ?? 0n);
    const slotClaimed = !!(claimedQ.data as boolean | undefined);
    const eligibleAtSec = lastSec > 0 ? lastSec + delaySec : 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const stale = lastSec > 0 && nowSec >= eligibleAtSec;

    const valid =
        idsValid
        && isAddress(pairedStr.trim())
        && (clankerStr.trim() === "" || isAddress(clankerStr.trim()))
        && isAddress(toStr.trim());

    const onSubmit = async () => {
        if (!valid) return;
        if (!window.confirm(
            `Forfeit slot ${slotIndexStr} of position ${positionIdStr}? `
            + `Credited balances will be transferred to ${toStr.trim()} and the slot marked claimed (future creditSlot calls will revert). This is irreversible.`,
        )) return;
        setSubmitting(true);
        try {
            const clankerArg = (clankerStr.trim() === "" ? "0x0000000000000000000000000000000000000000" : clankerStr.trim()) as Address;
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "forfeitStaleClaim",
                args: [positionId, slotIndex, pairedStr.trim() as Address, clankerArg, toStr.trim() as Address],
            });
            pushToast({ kind: "info", title: "Slot forfeited", message: "Future creditSlot for this slot will revert." });
            await lastCreditedAtQ.refetch();
            await claimedQ.refetch();
        } catch (e: any) {
            pushToast({ kind: "error", title: "Failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Card title="Forfeit stale claim" icon={<Clock className="h-4 w-4 text-arc-warn" />}>
            <p className="text-xs text-arc-text-muted">
                After {Math.floor(delaySec / 86400)} days of no <code>creditSlot</code>{" "}
                activity on a slot, the owner can route the credited balance to a chosen
                address. Designed for abandoned Twitter handles (account deleted, never
                claimed, etc.). Slot is marked claimed after forfeit so the locker&apos;s
                future credit attempts revert (and fall through to its{" "}
                <code>pendingWithdrawals</code> ledger, recoverable via <code>pullFromLocker</code>).
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
                <input
                    aria-label="Position ID"
                    type="number"
                    min={0}
                    placeholder="positionId"
                    value={positionIdStr}
                    onChange={(e) => setPositionIdStr(e.target.value)}
                    className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm"
                />
                <input
                    aria-label="Slot index"
                    type="number"
                    min={0}
                    placeholder="slotIndex"
                    value={slotIndexStr}
                    onChange={(e) => setSlotIndexStr(e.target.value)}
                    className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm"
                />
            </div>
            <input
                aria-label="Paired token address"
                type="text"
                placeholder="Paired token address (typically USDC)"
                value={pairedStr}
                onChange={(e) => setPairedStr(e.target.value)}
                className="arc-input mt-2 w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
            />
            <input
                aria-label="Launch token address"
                type="text"
                placeholder="Clanker / launch token address (optional)"
                value={clankerStr}
                onChange={(e) => setClankerStr(e.target.value)}
                className="arc-input mt-2 w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
            />
            <input
                aria-label="Recipient address"
                type="text"
                placeholder="Recipient (treasury, creator, charity…)"
                value={toStr}
                onChange={(e) => setToStr(e.target.value)}
                className="arc-input mt-2 w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
            />

            {idsValid && (
                <div className="mt-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-3 text-xs">
                    {slotClaimed ? (
                        <div className="text-arc-warn">Slot is already marked claimed - forfeit will revert.</div>
                    ) : lastSec === 0 ? (
                        <div className="text-arc-text-muted">Slot has never been credited. Nothing to forfeit.</div>
                    ) : stale ? (
                        <div className="text-arc-success">
                            Slot is stale (last credit {Math.floor((nowSec - lastSec) / 86400)} days ago). Eligible to forfeit.
                        </div>
                    ) : (
                        <div className="text-arc-text-muted">
                            Slot is still active. Eligible in {Math.ceil((eligibleAtSec - nowSec) / 86400)} more days
                            (last credit {Math.floor((nowSec - lastSec) / 86400)} days ago).
                        </div>
                    )}
                </div>
            )}

            <button type="button"
                onClick={onSubmit}
                disabled={!valid || submitting || (idsValid && !stale)}
                className={cn(
                    "mt-3 inline-flex items-center gap-2 rounded-xl bg-arc-warn/15 px-4 py-2 text-sm font-semibold text-arc-warn",
                    (!valid || submitting || (idsValid && !stale)) && "opacity-60",
                )}
            >
                <Clock className="h-4 w-4" />
                {submitting ? "Sending…" : "Forfeit slot"}
            </button>
        </Card>
    );
}

// ===================== Rescue =====================

function RescueCard() {
    const escrow = ADDRESSES.twitterEscrow;
    const { writeContractAsync } = useWriteContract();
    const [tokenInput, setTokenInput] = useState<string>(ADDRESSES.usdc);
    const [toInput, setToInput] = useState("");
    const [amountStr, setAmountStr] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const tokenAddr = tokenInput.trim();
    const tokenIsValid = isAddress(tokenAddr);
    const isUsdc = tokenIsValid && tokenAddr.toLowerCase() === ADDRESSES.usdc.toLowerCase();

    // Audit 2026-06-18b M-25: previously `decimals = isUsdc ? 6 : 18`,
    // which silently signed 10^(18-actual) too much when rescuing any
    // non-18-dec token — cirBTC (8 dec) would have been off by 10^10.
    // Read the token's real decimals() on-chain. While it is loading or
    // unreadable the form is disabled (decimalsKnown=false) so a wrong
    // amount can never be signed.
    const decimalsQ = useReadContract({
        address: tokenIsValid ? (tokenAddr as Address) : undefined,
        abi: erc20Abi,
        functionName: "decimals",
        query: { enabled: tokenIsValid && !isUsdc },
    });
    const decimals: number | undefined = isUsdc
        ? USDC_DECIMALS
        : (decimalsQ.data as number | undefined);
    const decimalsKnown = typeof decimals === "number";
    let amountRaw = 0n;
    try {
        amountRaw = amountStr && decimalsKnown ? parseUnits(amountStr, decimals) : 0n;
    } catch {}

    const valid =
        tokenIsValid
        && isAddress(toInput.trim())
        && decimalsKnown
        && amountRaw > 0n;

    const onSubmit = async () => {
        if (!valid) return;
        if (!window.confirm(`Rescue ${amountStr} ${isUsdc ? "USDC" : "tokens"} (${decimals} decimals) to ${toInput.trim()}? The contract enforces that this can't touch credited slot balances, but double-check the inputs.`)) return;
        setSubmitting(true);
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "rescue",
                args: [tokenInput.trim() as Address, toInput.trim() as Address, amountRaw],
            });
            pushToast({ kind: "info", title: "Rescue sent" });
            setAmountStr("");
        } catch (e: any) {
            pushToast({ kind: "error", title: "Failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Card title="Rescue" icon={<AlertTriangle className="h-4 w-4 text-arc-warn" />}>
            <p className="text-xs text-arc-text-muted">
                Sweep tokens NOT earmarked by <code>creditedTotal[token]</code>. Used for dust,
                accidentally-sent tokens, or to recover tokens pulled from the locker. The
                <code> rescue()</code> guard refuses any amount that would dip into credited
                user balances, so this is bounded by design.
            </p>
            <div className="mt-3 space-y-2">
                <input
                    aria-label="Token address"
                    type="text"
                    placeholder="Token address"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    className="arc-input w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
                />
                <input
                    aria-label="Recipient address"
                    type="text"
                    placeholder="Recipient address"
                    value={toInput}
                    onChange={(e) => setToInput(e.target.value)}
                    className="arc-input w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
                />
                <input
                    aria-label="Amount"
                    type="text"
                    inputMode="decimal"
                    placeholder={`Amount in ${isUsdc ? "USDC" : "tokens"}`}
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ""))}
                    className="arc-input w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm"
                />
            </div>
            <button type="button"
                onClick={onSubmit}
                disabled={!valid || submitting}
                className={cn(
                    "mt-3 inline-flex items-center gap-2 rounded-xl bg-arc-warn/15 px-4 py-2 text-sm font-semibold text-arc-warn",
                    (!valid || submitting) && "opacity-60",
                )}
            >
                <AlertTriangle className="h-4 w-4" />
                {submitting ? "Sending…" : "Rescue"}
            </button>
        </Card>
    );
}

// ===================== Ownership =====================

function OwnershipCard() {
    const escrow = ADDRESSES.twitterEscrow;
    const { writeContractAsync } = useWriteContract();
    const [next, setNext] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const valid = isAddress(next.trim()) && next.trim() !== zeroAddress;

    const onSubmit = async () => {
        if (!valid) return;
        if (!window.confirm(`Initiate ownership transfer to ${next.trim()}? Ownable2Step requires the NEW owner to call acceptOwnership() before the transfer completes.`)) return;
        setSubmitting(true);
        try {
            await writeContractAsync({
                address: escrow,
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "transferOwnership",
                args: [next.trim() as Address],
            });
            pushToast({
                kind: "info",
                title: "Transfer pending",
                message: "The new owner must call acceptOwnership() to finalize.",
            });
            setNext("");
        } catch (e: any) {
            pushToast({ kind: "error", title: "Failed", message: e?.shortMessage ?? e?.message });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Card title="Transfer ownership" icon={<LogIn className="h-4 w-4" />}>
            <p className="text-xs text-arc-text-muted">
                Uses Ownable2Step: this kicks off the transfer, the new owner must then call
                <code> acceptOwnership()</code> from their own wallet to finalize. The
                <code> renounceOwnership()</code> path is intentionally disabled
                (<code>RenounceDisabled</code> revert) to prevent the contract from being
                stranded.
            </p>
            <div className="mt-4 flex items-center gap-2">
                <input
                    aria-label="New owner address"
                    type="text"
                    placeholder="0x… new owner (typically a Safe multisig)"
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    className="arc-input flex-1 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-xs"
                />
                <button type="button"
                    onClick={onSubmit}
                    disabled={!valid || submitting}
                    className={cn("arc-button-primary px-4 py-2 text-sm", (!valid || submitting) && "opacity-60")}
                >
                    {submitting ? "Sending…" : "Initiate transfer"}
                </button>
            </div>
        </Card>
    );
}

// ===================== shared primitives =====================

function Card({
    title,
    icon,
    children,
}: {
    title: string;
    icon?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="arc-card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-arc-text">
                {icon}
                {title}
            </div>
            <div className="space-y-2 text-sm">{children}</div>
        </div>
    );
}

function Row({
    label,
    value,
    mono = false,
}: {
    label: string;
    value: React.ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="flex items-start justify-between gap-3 text-xs">
            <span className="shrink-0 text-arc-text-muted">{label}</span>
            <span className={cn("truncate text-right text-arc-text", mono && "font-mono")}>
                {value}
            </span>
        </div>
    );
}

// Silence unused-import lint for formatUSDC; we keep it as a helper for the
// rescue card preview if/when we add balance preview later.
void formatUSDC;
